import { z } from 'zod';
import { readBoundedResponseText } from './http-bounds';

export type IdentityProviderDecision = 'VERIFIED' | 'PENDING' | 'REJECTED';

export type IdentityVerificationRequest = {
  verificationId: string;
  userId: string;
  nationalId: string;
  dateOfBirth: string;
};

export type IdentityVerificationResult = {
  status: IdentityProviderDecision;
  providerReference?: string;
};

const providerResponseSchema = z.object({
  status: z.enum(['VERIFIED', 'PENDING', 'REJECTED']),
  providerReference: z.string().trim().min(1).max(300).optional(),
  nationalId: z.string().trim().optional(),
  dateOfBirth: z.string().trim().optional(),
});

const arabicDigits = '٠١٢٣٤٥٦٧٨٩';
const easternArabicDigits = '۰۱۲۳۴۵۶۷۸۹';

export function normalizeNationalId(value: string) {
  return value
    .trim()
    .replace(/[٠-٩]/g, digit => String(arabicDigits.indexOf(digit)))
    .replace(/[۰-۹]/g, digit => String(easternArabicDigits.indexOf(digit)))
    .replace(/[\s-]/g, '');
}

export function parseDateOnly(value: string) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) throw new Error('INVALID_DATE_OF_BIRTH');
  const [year, month, day] = value.split('-').map(Number);
  const date = new Date(Date.UTC(year, month - 1, day));
  if (date.getUTCFullYear() !== year || date.getUTCMonth() !== month - 1 || date.getUTCDate() !== day) throw new Error('INVALID_DATE_OF_BIRTH');
  return date;
}

export function formatDateOnly(value: Date) {
  return value.toISOString().slice(0, 10);
}

export function isAdult(dateOfBirth: Date, now = new Date()) {
  const cutoff = new Date(Date.UTC(now.getUTCFullYear() - 18, now.getUTCMonth(), now.getUTCDate()));
  return dateOfBirth <= cutoff;
}

export class HttpIdentityProvider {
  readonly name = 'HTTP_IDENTITY_PROVIDER';

  constructor(
    private readonly endpoint: URL,
    private readonly secret: string,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}

  async verifyIdentity(request: IdentityVerificationRequest): Promise<IdentityVerificationResult> {
    let response: Response;
    try {
      response = await this.fetchImpl(this.endpoint, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${this.secret}`,
          'Idempotency-Key': request.verificationId,
        },
        body: JSON.stringify({
          requestId: request.verificationId,
          subjectId: request.userId,
          nationalId: request.nationalId,
          dateOfBirth: request.dateOfBirth,
        }),
        cache: 'no-store',
        redirect: 'error',
        signal: AbortSignal.timeout(10_000),
      });
    } catch {
      throw new Error('IDENTITY_PROVIDER_UNAVAILABLE');
    }

    if (!response.ok) throw new Error('IDENTITY_PROVIDER_UNAVAILABLE');
    const body = await readBoundedResponseText(response, 64 * 1024, 'IDENTITY_PROVIDER_RESPONSE_INVALID');
    if (body.length === 0) throw new Error('IDENTITY_PROVIDER_RESPONSE_INVALID');

    let json: unknown;
    try {
      json = JSON.parse(body);
    } catch {
      throw new Error('IDENTITY_PROVIDER_RESPONSE_INVALID');
    }
    const parsed = providerResponseSchema.safeParse(json);
    if (!parsed.success) throw new Error('IDENTITY_PROVIDER_RESPONSE_INVALID');

    if (parsed.data.status === 'VERIFIED') {
      if (!parsed.data.providerReference || !parsed.data.nationalId || !parsed.data.dateOfBirth) throw new Error('IDENTITY_PROVIDER_RESPONSE_INVALID');
      if (normalizeNationalId(parsed.data.nationalId) !== request.nationalId || formatDateOnly(parseDateOnly(parsed.data.dateOfBirth)) !== request.dateOfBirth) {
        throw new Error('IDENTITY_PROVIDER_SUBJECT_MISMATCH');
      }
    }

    return { status: parsed.data.status, providerReference: parsed.data.providerReference };
  }
}

export function getIdentityProvider() {
  const rawUrl = process.env.IDENTITY_PROVIDER_URL?.trim();
  const secret = process.env.IDENTITY_PROVIDER_SECRET?.trim();
  if (!rawUrl || !secret) throw new Error('NOT_CONFIGURED:IDENTITY_PROVIDER_REQUIRED');

  let endpoint: URL;
  try {
    endpoint = new URL(rawUrl);
  } catch {
    throw new Error('NOT_CONFIGURED:IDENTITY_PROVIDER_URL_INVALID');
  }
  if (!['http:', 'https:'].includes(endpoint.protocol) || endpoint.username || endpoint.password) throw new Error('NOT_CONFIGURED:IDENTITY_PROVIDER_URL_INVALID');
  if (process.env.NODE_ENV === 'production' && endpoint.protocol !== 'https:') throw new Error('NOT_CONFIGURED:IDENTITY_PROVIDER_HTTPS_REQUIRED');
  return new HttpIdentityProvider(endpoint, secret);
}
