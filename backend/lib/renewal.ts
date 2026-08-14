import { createHash } from 'crypto';
import { z } from 'zod';
import { getTrafficProviderHttpClient, safeTrafficProviderActionUrl, TrafficProviderHttpClient } from './traffic-provider-http';

export type RenewalStatus = 'PAYMENT_REQUIRED' | 'PENDING_GOVERNMENT' | 'COMPLETED' | 'REJECTED' | 'FAILED';

export type RenewalEligibility = {
  eligible: boolean;
  reasonCode?: string;
  feesYER: number;
  currentExpiryDate: Date | null;
  cycleId?: string;
  eligibilityReference?: string;
};

export type RenewalResult = {
  status: RenewalStatus;
  providerSequence: number;
  providerReference?: string;
  newExpiryDate?: Date;
  checkoutUrl?: string;
};

export interface RenewalProvider {
  checkEligibility(request: {
    vehicleId: string;
    plateNumber: string;
    vin: string;
    idempotencyKey: string;
  }): Promise<RenewalEligibility>;
  submitRenewal(request: {
    vehicleId: string;
    plateNumber: string;
    vin: string;
    eligibility: RenewalEligibility;
    idempotencyKey: string;
  }): Promise<RenewalResult>;
  getRenewalStatus(request: {
    vehicleId: string;
    plateNumber: string;
    vin: string;
    providerReference: string;
    idempotencyKey: string;
  }): Promise<RenewalResult>;
}

const moneySchema = z.union([
  z.number().int().nonnegative().max(999_999_999_999),
  z.string().regex(/^\d{1,12}$/).transform(Number),
]);

const eligibilityResponseSchema = z.object({
  status: z.literal('CONFIRMED'),
  subject: z.object({
    vehicleId: z.string().min(1).max(100),
    plateNumber: z.string().min(1).max(50),
    vin: z.string().min(10).max(50),
  }),
  eligible: z.boolean(),
  reasonCode: z.string().trim().regex(/^[A-Z][A-Z0-9_]{0,79}$/).optional(),
  feesYER: moneySchema,
  currentExpiryDate: z.string().datetime({ offset: true }).nullable(),
  cycleId: z.string().trim().min(1).max(100).optional(),
  eligibilityReference: z.string().trim().min(1).max(300).optional(),
}).superRefine((value, context) => {
  if (value.eligible && (!value.cycleId || !value.eligibilityReference)) {
    context.addIssue({ code: 'custom', message: 'eligible renewal requires bound references' });
  }
});

const renewalResponseSchema = z.object({
  status: z.enum(['PAYMENT_REQUIRED', 'PENDING_GOVERNMENT', 'COMPLETED', 'REJECTED', 'FAILED']),
  providerSequence: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  subject: z.object({
    vehicleId: z.string().min(1).max(100),
    plateNumber: z.string().min(1).max(50),
    vin: z.string().min(10).max(50),
  }),
  providerReference: z.string().trim().min(1).max(300).optional(),
  newExpiryDate: z.string().datetime({ offset: true }).optional(),
  checkoutUrl: z.string().trim().max(2_048).optional(),
}).superRefine((value, context) => {
  if (['PAYMENT_REQUIRED', 'PENDING_GOVERNMENT', 'COMPLETED'].includes(value.status) && !value.providerReference) {
    context.addIssue({ code: 'custom', message: 'accepted renewal requires provider reference' });
  }
  if (value.status === 'PAYMENT_REQUIRED' && !value.checkoutUrl) {
    context.addIssue({ code: 'custom', message: 'payment-required renewal requires checkout URL' });
  }
  if (value.status === 'COMPLETED' && !value.newExpiryDate) {
    context.addIssue({ code: 'custom', message: 'completed renewal requires expiry date' });
  }
});

function parseRenewalResult(raw: unknown, vehicle: { id: string; plateNumber: string; vin: string }): RenewalResult {
  const parsed = renewalResponseSchema.safeParse(raw);
  if (!parsed.success) throw new Error('TRAFFIC_PROVIDER_RESPONSE_INVALID');
  if (parsed.data.subject.vehicleId !== vehicle.id || parsed.data.subject.plateNumber !== vehicle.plateNumber || parsed.data.subject.vin !== vehicle.vin) {
    throw new Error('TRAFFIC_PROVIDER_SUBJECT_MISMATCH');
  }
  return {
    status: parsed.data.status,
    providerSequence: parsed.data.providerSequence,
    providerReference: parsed.data.providerReference,
    newExpiryDate: parsed.data.newExpiryDate ? new Date(parsed.data.newExpiryDate) : undefined,
    checkoutUrl: parsed.data.status === 'PAYMENT_REQUIRED' ? safeTrafficProviderActionUrl(parsed.data.checkoutUrl) : undefined,
  };
}

export class HttpRenewalProvider implements RenewalProvider {
  constructor(private readonly client: TrafficProviderHttpClient) {}

  async checkEligibility(request: { vehicleId: string; plateNumber: string; vin: string; idempotencyKey: string }): Promise<RenewalEligibility> {
    const raw = await this.client.post('CHECK_REGISTRATION_RENEWAL_ELIGIBILITY', {
      vehicle: { id: request.vehicleId, plateNumber: request.plateNumber, vin: request.vin },
    }, request.idempotencyKey);
    const parsed = eligibilityResponseSchema.safeParse(raw);
    if (!parsed.success) throw new Error('TRAFFIC_PROVIDER_RESPONSE_INVALID');
    if (parsed.data.subject.vehicleId !== request.vehicleId || parsed.data.subject.plateNumber !== request.plateNumber || parsed.data.subject.vin !== request.vin) {
      throw new Error('TRAFFIC_PROVIDER_SUBJECT_MISMATCH');
    }
    return {
      eligible: parsed.data.eligible,
      reasonCode: parsed.data.reasonCode,
      feesYER: parsed.data.feesYER,
      currentExpiryDate: parsed.data.currentExpiryDate ? new Date(parsed.data.currentExpiryDate) : null,
      cycleId: parsed.data.cycleId,
      eligibilityReference: parsed.data.eligibilityReference,
    };
  }

  async submitRenewal(request: { vehicleId: string; plateNumber: string; vin: string; eligibility: RenewalEligibility; idempotencyKey: string }): Promise<RenewalResult> {
    if (!request.eligibility.eligible || !request.eligibility.cycleId || !request.eligibility.eligibilityReference) {
      throw new Error('REGISTRATION_RENEWAL_NOT_ELIGIBLE');
    }
    const raw = await this.client.post('SUBMIT_REGISTRATION_RENEWAL', {
      vehicle: { id: request.vehicleId, plateNumber: request.plateNumber, vin: request.vin },
      renewalCycle: request.eligibility.cycleId,
      eligibilityReference: request.eligibility.eligibilityReference,
      quotedFeesYER: request.eligibility.feesYER,
      currency: 'YER',
    }, request.idempotencyKey);
    return parseRenewalResult(raw, { id: request.vehicleId, plateNumber: request.plateNumber, vin: request.vin });
  }

  async getRenewalStatus(request: { vehicleId: string; plateNumber: string; vin: string; providerReference: string; idempotencyKey: string }): Promise<RenewalResult> {
    const raw = await this.client.post('GET_REGISTRATION_RENEWAL_STATUS', {
      vehicle: { id: request.vehicleId, plateNumber: request.plateNumber, vin: request.vin },
      providerReference: request.providerReference,
    }, request.idempotencyKey);
    const result = parseRenewalResult(raw, { id: request.vehicleId, plateNumber: request.plateNumber, vin: request.vin });
    if (result.providerReference !== request.providerReference) throw new Error('TRAFFIC_PROVIDER_SUBJECT_MISMATCH');
    return result;
  }
}

export function getRenewalProvider(): RenewalProvider {
  return new HttpRenewalProvider(getTrafficProviderHttpClient());
}

export function deriveRenewalEligibilityKey(vehicleId: string, plateNumber: string, vin: string, now = new Date()) {
  const minute = now.toISOString().slice(0, 16);
  return `RENEWAL_ELIGIBILITY:${createHash('sha256').update(`${vehicleId}|${plateNumber}|${vin}|${minute}`).digest('hex')}`;
}

export function deriveRenewalRequestKey(vehicleId: string, plateNumber: string, vin: string, cycleId: string) {
  return `REGISTRATION_RENEWAL:${createHash('sha256').update(`${vehicleId}|${plateNumber}|${vin}|${cycleId}`).digest('hex')}`;
}

export function deriveRenewalStatusKey(operationId: string, providerReference: string, now = new Date()) {
  const minute = now.toISOString().slice(0, 16);
  return `REGISTRATION_RENEWAL_STATUS:${createHash('sha256').update(`${operationId}|${providerReference}|${minute}`).digest('hex')}`;
}

export function publicRenewalEligibility(eligibility: RenewalEligibility) {
  return {
    eligible: eligibility.eligible,
    reasonCode: eligibility.reasonCode,
    feesYER: eligibility.feesYER,
    currentExpiryDate: eligibility.currentExpiryDate,
  };
}
