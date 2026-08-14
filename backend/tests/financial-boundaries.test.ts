import { describe, expect, it } from 'vitest';
import { parseBankProviderResponse } from '../lib/payout-account';
import { paymentInitiationFallbackStatus } from '../lib/sale-provider-requests';
import { assertTrafficTransferRequestBinding, isHandoverConsentBound, saleOtpOperationId } from '../lib/transfer-workflow';

describe('financial and transfer security boundaries', () => {
  it('separates sale-consent OTPs from handover OTPs', () => {
    expect(saleOtpOperationId('sale-1', 'SALE_CONSENT')).toBe('sale-1:SALE_CONSENT');
    expect(saleOtpOperationId('sale-1', 'HANDOVER')).toBe('sale-1:HANDOVER');
    expect(saleOtpOperationId('sale-1', 'SALE_CONSENT')).not.toBe(saleOtpOperationId('sale-1', 'HANDOVER'));
  });

  it('accepts stored handover consent only when its consumed OTP has the handover purpose', () => {
    const operation = { type: 'HANDOVER_PARTY_CONSENT', status: 'SUCCESS', userId: 'buyer-1', providerReference: 'otp-1', metadata: { saleId: 'sale-1', party: 'BUYER' } };
    const handoverOtp = { id: 'otp-1', operationId: 'sale-1:HANDOVER', type: 'BUYER', userId: 'buyer-1', isUsed: true, verifiedAt: new Date() };
    expect(isHandoverConsentBound({ saleId: 'sale-1', party: 'BUYER', userId: 'buyer-1', operation, otp: handoverOtp })).toBe(true);
    expect(isHandoverConsentBound({ saleId: 'sale-1', party: 'BUYER', userId: 'buyer-1', operation, otp: { ...handoverOtp, operationId: 'sale-1:SALE_CONSENT' } })).toBe(false);
  });

  it('requires the payout provider to attest the holder name', () => {
    expect(() => parseBankProviderResponse({ valid: true, providerReference: 'bank-ref' })).toThrow('BANK_PROVIDER_RESPONSE_INVALID');
    expect(parseBankProviderResponse({ valid: true, providerReference: 'bank-ref', holderName: 'اسم موثق' }).holderName).toBe('اسم موثق');
  });

  it('restores failed auction payments to waiting payment without changing direct-sale semantics', () => {
    expect(paymentInitiationFallbackStatus({ status: 'PAYMENT_PROCESSING', auctionId: 'auction-1' })).toBe('WAITING_PAYMENT');
    expect(paymentInitiationFallbackStatus({ status: 'WAITING_PAYMENT', auctionId: null })).toBe('WAITING_PAYMENT');
    expect(paymentInitiationFallbackStatus({ status: 'PAYMENT_PROCESSING', auctionId: null })).toBe('BUYER_ACCEPTED');
  });

  it('binds a traffic callback to the successful server-created operation', () => {
    const operation = { type: 'TRAFFIC_TRANSFER_REQUEST', status: 'SUCCESS', providerReference: 'traffic-ref', metadata: { saleId: 'sale-1' } };
    expect(() => assertTrafficTransferRequestBinding({ saleId: 'sale-1', saleGovernmentReference: 'traffic-ref', providerReference: 'traffic-ref', operation })).not.toThrow();
    expect(() => assertTrafficTransferRequestBinding({ saleId: 'sale-1', saleGovernmentReference: 'traffic-ref', providerReference: 'forged-ref', operation })).toThrow('TRAFFIC_TRANSFER_REQUEST_MISMATCH');
    expect(() => assertTrafficTransferRequestBinding({ saleId: 'sale-1', saleGovernmentReference: null, providerReference: 'traffic-ref', operation: null })).toThrow('TRAFFIC_TRANSFER_REQUEST_MISMATCH');
  });
});
