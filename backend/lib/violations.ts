import { createHash } from 'crypto';
import { z } from 'zod';
import { getTrafficProviderHttpClient, safeTrafficProviderActionUrl, TrafficProviderHttpClient } from './traffic-provider-http';

export type ViolationStatus = 'PENDING' | 'PAID' | 'DISPUTED' | 'CANCELLED';
export type ViolationType = 'SPEEDING' | 'PARKING' | 'SIGNAL' | 'LICENSE' | 'OTHER';
export type ViolationPaymentStatus = 'PAYMENT_REQUIRED' | 'PENDING' | 'PAID' | 'FAILED';

export type ViolationSnapshot = {
  externalReference: string;
  type: ViolationType;
  summary: string;
  amountYER: number;
  issuedAt: Date;
  dueAt: Date | null;
  status: ViolationStatus;
};

export type ViolationInquiryResult = {
  snapshotSequence: number;
  violations: ViolationSnapshot[];
};

export type ViolationInquiryRequest = {
  vehicleId: string;
  plateNumber: string;
  vin: string;
  idempotencyKey: string;
};

export type ViolationPaymentRequest = {
  vehicleId: string;
  plateNumber: string;
  vin: string;
  externalReference: string;
  amountYER: number;
  idempotencyKey: string;
};

export type ViolationPaymentResult = {
  status: ViolationPaymentStatus;
  providerReference?: string;
  checkoutUrl?: string;
};

export interface ViolationProvider {
  inquiryViolations(request: ViolationInquiryRequest): Promise<ViolationInquiryResult>;
  startPayment(request: ViolationPaymentRequest): Promise<ViolationPaymentResult>;
}

const moneySchema = z.union([
  z.number().int().positive().max(999_999_999_999),
  z.string().regex(/^[1-9]\d{0,11}$/).transform(Number),
]);

const inquiryResponseSchema = z.object({
  status: z.literal('CONFIRMED'),
  snapshotComplete: z.literal(true),
  snapshotSequence: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  subject: z.object({
    vehicleId: z.string().min(1).max(100),
    plateNumber: z.string().min(1).max(50),
    vin: z.string().min(10).max(50),
  }),
  violations: z.array(z.object({
    reference: z.string().trim().min(1).max(300),
    type: z.enum(['SPEEDING', 'PARKING', 'SIGNAL', 'LICENSE', 'OTHER']),
    summary: z.string().trim().min(1).max(500),
    amountYER: moneySchema,
    issuedAt: z.string().datetime({ offset: true }),
    dueAt: z.string().datetime({ offset: true }).nullable().optional(),
    status: z.enum(['PENDING', 'PAID', 'DISPUTED', 'CANCELLED']),
  })).max(200),
});

const paymentResponseSchema = z.object({
  status: z.enum(['PAYMENT_REQUIRED', 'PENDING', 'PAID', 'FAILED']),
  subject: z.object({
    vehicleId: z.string().min(1).max(100),
    plateNumber: z.string().min(1).max(50),
    vin: z.string().min(10).max(50),
    violationReference: z.string().min(1).max(300),
  }),
  providerReference: z.string().trim().min(1).max(300).optional(),
  paidAmountYER: moneySchema.optional(),
  checkoutUrl: z.string().trim().max(2_048).optional(),
});

function cleanProviderText(value: string) {
  return value.replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim();
}

export function safeProviderCheckoutUrl(value: string | undefined) {
  return safeTrafficProviderActionUrl(value);
}

export class HttpViolationProvider implements ViolationProvider {
  constructor(private readonly client: TrafficProviderHttpClient) {}

  async inquiryViolations(request: ViolationInquiryRequest): Promise<ViolationInquiryResult> {
    const raw = await this.client.post('INQUIRE_VEHICLE_VIOLATIONS', {
      vehicle: { id: request.vehicleId, plateNumber: request.plateNumber, vin: request.vin },
    }, request.idempotencyKey);
    const parsed = inquiryResponseSchema.safeParse(raw);
    if (!parsed.success) throw new Error('TRAFFIC_PROVIDER_RESPONSE_INVALID');
    if (parsed.data.subject.vehicleId !== request.vehicleId || parsed.data.subject.plateNumber !== request.plateNumber || parsed.data.subject.vin !== request.vin) {
      throw new Error('TRAFFIC_PROVIDER_SUBJECT_MISMATCH');
    }

    const references = new Set<string>();
    const violations = parsed.data.violations.map(item => {
      if (references.has(item.reference)) throw new Error('TRAFFIC_PROVIDER_RESPONSE_INVALID');
      references.add(item.reference);
      const summary = cleanProviderText(item.summary);
      if (!summary) throw new Error('TRAFFIC_PROVIDER_RESPONSE_INVALID');
      return {
        externalReference: item.reference,
        type: item.type,
        summary,
        amountYER: item.amountYER,
        issuedAt: new Date(item.issuedAt),
        dueAt: item.dueAt ? new Date(item.dueAt) : null,
        status: item.status,
      };
    });
    return { snapshotSequence: parsed.data.snapshotSequence, violations };
  }

  async startPayment(request: ViolationPaymentRequest): Promise<ViolationPaymentResult> {
    const raw = await this.client.post('START_VIOLATION_PAYMENT', {
      vehicle: { id: request.vehicleId, plateNumber: request.plateNumber, vin: request.vin },
      violationReference: request.externalReference,
      amountYER: request.amountYER,
      currency: 'YER',
    }, request.idempotencyKey);
    const parsed = paymentResponseSchema.safeParse(raw);
    if (!parsed.success) throw new Error('TRAFFIC_PROVIDER_RESPONSE_INVALID');
    const result = parsed.data;
    if (result.subject.vehicleId !== request.vehicleId || result.subject.plateNumber !== request.plateNumber || result.subject.vin !== request.vin || result.subject.violationReference !== request.externalReference) {
      throw new Error('TRAFFIC_PROVIDER_SUBJECT_MISMATCH');
    }
    if (result.status === 'PAID' && (!result.providerReference || result.paidAmountYER !== request.amountYER)) {
      throw new Error('TRAFFIC_PROVIDER_AMOUNT_MISMATCH');
    }
    if (result.status === 'PAYMENT_REQUIRED' && !result.checkoutUrl) throw new Error('TRAFFIC_PROVIDER_RESPONSE_INVALID');
    return {
      status: result.status,
      providerReference: result.providerReference,
      checkoutUrl: result.status === 'PAYMENT_REQUIRED' ? safeProviderCheckoutUrl(result.checkoutUrl) : undefined,
    };
  }
}

export function getViolationProvider(): ViolationProvider {
  return new HttpViolationProvider(getTrafficProviderHttpClient());
}

export function deriveViolationInquiryKey(vehicleId: string, plateNumber: string, vin: string, now = new Date()) {
  const minute = now.toISOString().slice(0, 16);
  return `VIOLATION_INQUIRY:${createHash('sha256').update(`${vehicleId}|${plateNumber}|${vin}|${minute}`).digest('hex')}`;
}

export function deriveViolationInquiryStateKey(vehicleId: string, plateNumber: string, vin: string) {
  return `VIOLATION_INQUIRY_STATE:${createHash('sha256').update(`${vehicleId}|${plateNumber}|${vin}`).digest('hex')}`;
}

export function deriveViolationPaymentKey(vehicleId: string, violationId: string, userId: string, externalReference: string, amountYER: number) {
  return `VIOLATION_PAYMENT:${createHash('sha256').update(`${vehicleId}|${violationId}|${userId}|${externalReference}|${amountYER}`).digest('hex')}`;
}

export function publicViolation(violation: {
  id: string;
  type: string;
  description: string;
  amount: { toString(): string } | number | string;
  status: string;
  issuedAt: Date;
  dueAt: Date | null;
}) {
  return {
    id: violation.id,
    type: violation.type,
    summary: violation.description,
    amountYER: Number(violation.amount),
    status: violation.status,
    issuedAt: violation.issuedAt,
    dueAt: violation.dueAt,
  };
}
