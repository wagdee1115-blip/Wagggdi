import { createCipheriv, createHmac, randomBytes } from 'crypto';
import { Prisma } from '@prisma/client';
import { z } from 'zod';
import { db } from './db';
import { readBoundedResponseText } from './http-bounds';
import { isIdentityVerified } from './identity-policy';
import { requireProviderEndpoint } from './provider-endpoint';

function normalizeName(value: string) { return value.trim().replace(/\s+/g, ' ').toLocaleLowerCase('ar-YE'); }

function encryptionKey() {
  const configured = process.env.PAYOUT_DATA_ENCRYPTION_KEY;
  if (!configured) throw new Error('NOT_CONFIGURED:PAYOUT_ENCRYPTION_KEY_REQUIRED');
  const key = /^[a-f\d]{64}$/i.test(configured) ? Buffer.from(configured, 'hex') : Buffer.from(configured, 'base64');
  if (key.length !== 32) throw new Error('INVALID_CONFIG:PAYOUT_ENCRYPTION_KEY');
  return key;
}

function encryptAccountIdentifier(identifier: string) {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', encryptionKey(), iv);
  const ciphertext = Buffer.concat([cipher.update(identifier, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `v1:${iv.toString('base64url')}:${tag.toString('base64url')}:${ciphertext.toString('base64url')}`;
}

function maskAccountIdentifier(identifier: string) {
  const compact = identifier.replace(/\s+/g, '');
  return `•••• ${compact.slice(-4)}`;
}

const bankProviderResponseSchema = z.object({
  valid: z.boolean(),
  holderName: z.string().trim().min(2).max(200),
  providerReference: z.string().trim().min(1).max(300).optional(),
}).strict();

export function parseBankProviderResponse(value: unknown) {
  const parsed = bankProviderResponseSchema.safeParse(value);
  if (!parsed.success) throw new Error('BANK_PROVIDER_RESPONSE_INVALID');
  return parsed.data;
}

export async function verifyPayoutAccount(params: { userId: string; provider: string; accountIdentifier: string; accountHolderName: string }) {
  const user = await db.user.findUnique({ where: { id: params.userId } });
  if (!user) throw new Error('USER_NOT_FOUND');
  if (user.phoneStatus !== 'VERIFIED') throw new Error('PHONE_NOT_VERIFIED');
  if (!isIdentityVerified(user)) throw new Error('IDENTITY_NOT_VERIFIED');
  const dataEncryptionKey = encryptionKey();
  const providerUrl = requireProviderEndpoint(process.env.BANK_PROVIDER_URL, 'BANK_PROVIDER');
  const secret = process.env.BANK_PROVIDER_SECRET;
  if (!secret) throw new Error('NOT_CONFIGURED:BANK_PROVIDER_REQUIRED');
  const idempotencyKey = createHmac('sha256', dataEncryptionKey)
    .update(`${params.userId}\0${params.provider}\0${params.accountIdentifier}`)
    .digest('hex');
  let response: Response;
  try {
    response = await fetch(providerUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${secret}`, 'idempotency-key': `PAYOUT_VERIFY:${idempotencyKey}` },
      body: JSON.stringify({ provider: params.provider, accountIdentifier: params.accountIdentifier, holderName: params.accountHolderName }),
      signal: AbortSignal.timeout(15_000),
      redirect: 'error',
      cache: 'no-store',
    });
  } catch {
    throw new Error('BANK_PROVIDER_UNAVAILABLE');
  }
  if (!response.ok) throw new Error('BANK_PROVIDER_FAILED');
  const body = await readBoundedResponseText(response, 64 * 1024, 'BANK_PROVIDER_RESPONSE_INVALID');
  if (!body) throw new Error('BANK_PROVIDER_RESPONSE_INVALID');
  let rawResult: unknown;
  try { rawResult = JSON.parse(body); } catch { throw new Error('BANK_PROVIDER_RESPONSE_INVALID'); }
  const result = parseBankProviderResponse(rawResult);
  if (!result.valid || !result.providerReference) throw new Error('PAYOUT_ACCOUNT_NOT_VERIFIED');
  const accountHolderName = result.holderName;
  const nameMatchStatus = normalizeName(accountHolderName) === normalizeName(user.fullName) ? 'MATCH' : 'MISMATCH';
  const values = {
    provider: params.provider,
    accountIdentifierEncrypted: encryptAccountIdentifier(params.accountIdentifier),
    accountIdentifierMasked: maskAccountIdentifier(params.accountIdentifier),
    accountHolderName,
    verified: nameMatchStatus === 'MATCH',
    nameMatchStatus,
    providerReference: result.providerReference,
  };
  const existing = await db.payoutAccount.findUnique({ where: { providerReference: result.providerReference } });
  if (existing && existing.userId !== user.id) throw new Error('PAYOUT_PROVIDER_REFERENCE_REPLAY');
  try {
    return existing
      ? await db.payoutAccount.update({ where: { id: existing.id }, data: values })
      : await db.payoutAccount.create({ data: { userId: user.id, ...values } });
  } catch (error) {
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
      throw new Error('PAYOUT_PROVIDER_REFERENCE_REPLAY');
    }
    throw error;
  }
}

export const payoutAccountPublicSelect = {
  id: true,
  provider: true,
  accountIdentifierMasked: true,
  accountHolderName: true,
  verified: true,
  nameMatchStatus: true,
  createdAt: true,
  updatedAt: true,
} as const;
