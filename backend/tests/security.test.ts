import { createHash } from 'crypto';
import { describe, expect, it, vi } from 'vitest';
import { hashOtpForStorage, otpHashMatches, OtpService, type OtpProvider } from '../lib/otp';
import { uploadVehicleMedia } from '../lib/vehicle-media';
import { canRequestSaleStatus } from '../lib/transfer-workflow';
import { isActiveAccount, isOnboardingAccount, safeApiErrorCode } from '../lib/api-auth';
import { requireProviderEndpoint } from '../lib/provider-endpoint';
import { safeInternalDestination } from '../lib/safe-navigation';
import { assertSafeStorageKey } from '../lib/storage';
import { readBoundedRequestText } from '../lib/request-body';

const unavailableProvider: OtpProvider = {
  name: 'UNAVAILABLE_TEST_PROVIDER',
  configured: false,
  async sendOtp() {
    throw new Error('SHOULD_NOT_SEND');
  },
};

describe('Security contracts backed by production code', () => {
  it('rejects malformed OTP values before any database or provider call', async () => {
    const service = new OtpService(unavailableProvider);
    await expect(service.verifyOtp({ otpId: 'unused', otp: '123456', operationId: 'unused', type: 'BUYER', userId: 'unused' }))
      .rejects.toThrow('OTP_INVALID_FORMAT');
    await expect(service.verifyOtp({ otpId: 'unused', otp: 'abcd', operationId: 'unused', type: 'BUYER', userId: 'unused' }))
      .rejects.toThrow('OTP_INVALID_FORMAT');
  });

  it('stores OTPs as keyed, operation-bound digests instead of bare hashes', () => {
    vi.stubEnv('OTP_HASH_SECRET', 'test-only-otp-secret-that-is-at-least-32-characters');
    try {
      const otp = '1234';
      const buyerContext = { userId: 'buyer-1', operationId: 'sale-1', type: 'BUYER' as const };
      const otherContext = { userId: 'buyer-2', operationId: 'sale-1', type: 'BUYER' as const };
      const stored = hashOtpForStorage(otp, buyerContext);

      expect(stored).toMatch(/^h1:[a-f0-9]{64}$/);
      expect(stored).not.toContain(createHash('sha256').update(otp).digest('hex'));
      expect(hashOtpForStorage(otp, otherContext)).not.toBe(stored);
      expect(otpHashMatches(otp, buyerContext, stored)).toBe(true);
      expect(otpHashMatches('9999', buyerContext, stored)).toBe(false);
      expect(otpHashMatches(otp, otherContext, stored)).toBe(false);
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it('rejects executable uploads and spoofed image bytes through the real media validator', async () => {
    const executable = new File([new Uint8Array([0x4d, 0x5a])], 'payload.exe', { type: 'application/x-msdownload' });
    await expect(uploadVehicleMedia({ vehicleId: 'unused', userId: 'unused', file: executable, mediaType: 'PRIMARY' }))
      .rejects.toThrow('UNSUPPORTED_MEDIA_TYPE');

    const spoofedPng = new File([new Uint8Array([0x4d, 0x5a, 0x90])], 'spoofed.png', { type: 'image/png' });
    await expect(uploadVehicleMedia({ vehicleId: 'unused', userId: 'unused', file: spoofedPng, mediaType: 'PRIMARY' }))
      .rejects.toThrow('MEDIA_MAGIC_BYTES_INVALID');
  });

  it('keeps provider-managed financial states outside ordinary user control', () => {
    expect(canRequestSaleStatus('USER', 'BUYER_ACCEPTED')).toBe(true);
    expect(canRequestSaleStatus('USER', 'PAYMENT_CONFIRMED')).toBe(false);
    expect(canRequestSaleStatus('USER', 'ESCROW_HELD')).toBe(false);
    expect(canRequestSaleStatus('USER', 'PAYOUT_CONFIRMED')).toBe(false);
    expect(canRequestSaleStatus('FINANCE', 'PAYMENT_CONFIRMED')).toBe(true);
  });

  it('admits only active accounts at the canonical authentication boundary', () => {
    expect(isActiveAccount({ status: 'ACTIVE' })).toBe(true);
    expect(isActiveAccount({ status: 'SUSPENDED' })).toBe(false);
    expect(isOnboardingAccount({ status: 'PENDING', role: 'USER' })).toBe(true);
    expect(isOnboardingAccount({ status: 'PENDING', role: 'ADMIN' })).toBe(false);
  });

  it('does not expose database or runtime exception details through the shared API error boundary', () => {
    expect(safeApiErrorCode(new Error('SALE_NOT_FOUND'))).toBe('SALE_NOT_FOUND');
    expect(safeApiErrorCode(new Error('INVALID_SALE_TRANSITION:BUYER_PENDING->BUYER_ACCEPTED'))).toBe('INVALID_SALE_TRANSITION:BUYER_PENDING->BUYER_ACCEPTED');
    expect(safeApiErrorCode(new Error('Unique constraint failed on the fields: (`nationalId`)'))).toBe('INTERNAL_ERROR');
    expect(safeApiErrorCode(new TypeError('Cannot read properties of undefined'))).toBe('INTERNAL_ERROR');
  });

  it('rejects unsafe provider endpoints in production', () => {
    vi.stubEnv('NODE_ENV', 'production');
    try {
      expect(() => requireProviderEndpoint('http://payments.example.test', 'PAYMENT_PROVIDER')).toThrow('NOT_CONFIGURED:PAYMENT_PROVIDER_HTTPS_REQUIRED');
      expect(() => requireProviderEndpoint('https://user:pass@payments.example.test', 'PAYMENT_PROVIDER')).toThrow('NOT_CONFIGURED:PAYMENT_PROVIDER_URL_INVALID');
      expect(requireProviderEndpoint('https://payments.example.test/path', 'PAYMENT_PROVIDER')).toBe('https://payments.example.test/path');
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it('keeps post-login navigation on the application origin', () => {
    const origin = 'https://markabat.example';
    expect(safeInternalDestination('/vehicles?tab=active#mine', origin)).toBe('/vehicles?tab=active#mine');
    expect(safeInternalDestination('//evil.example', origin)).toBe('/');
    expect(safeInternalDestination('/\\evil.example', origin)).toBe('/');
    expect(safeInternalDestination('https://evil.example', origin)).toBe('/');
  });

  it('keeps provider-controlled storage keys inside their assigned scope', () => {
    expect(assertSafeStorageKey('vehicles/v1/optimized/image-1', 'vehicles/v1/optimized')).toBe('vehicles/v1/optimized/image-1');
    expect(() => assertSafeStorageKey('../secret', 'vehicles/v1/optimized')).toThrow('STORAGE_KEY_INVALID');
    expect(() => assertSafeStorageKey('vehicles/v2/optimized/image-1', 'vehicles/v1/optimized')).toThrow('STORAGE_KEY_SCOPE_INVALID');
    expect(() => assertSafeStorageKey('vehicles\\v1\\image-1')).toThrow('STORAGE_KEY_INVALID');
  });

  it('rejects oversized or contradictory callback bodies', async () => {
    await expect(readBoundedRequestText(new Request('https://markabat.test/webhook', {
      method: 'POST', headers: { 'content-length': '70000' }, body: '{}',
    }))).rejects.toThrow('PAYLOAD_TOO_LARGE');
    await expect(readBoundedRequestText(new Request('https://markabat.test/webhook', {
      method: 'POST', body: 'x'.repeat(70_000),
    }))).rejects.toThrow('PAYLOAD_TOO_LARGE');
    await expect(readBoundedRequestText(new Request('https://markabat.test/webhook', {
      method: 'POST', headers: { 'content-length': 'not-a-number' }, body: '{}',
    }))).rejects.toThrow('INVALID_CONTENT_LENGTH');
  });
});
