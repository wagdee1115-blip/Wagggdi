import { describe, expect, it } from 'vitest';
import { canRequestSaleStatus, isAllowedSaleTransition } from '../lib/transfer-workflow';

describe('Direct Sale canonical state machine', () => {
  it('does not let customers impersonate payment, escrow, transfer, or payout providers', () => {
    expect(canRequestSaleStatus('USER', 'BUYER_ACCEPTED')).toBe(true);
    expect(canRequestSaleStatus('USER', 'CANCELLED')).toBe(true);
    expect(canRequestSaleStatus('USER', 'PAYMENT_CONFIRMED')).toBe(false);
    expect(canRequestSaleStatus('USER', 'ESCROW_HELD')).toBe(false);
    expect(canRequestSaleStatus('USER', 'TRANSFER_IN_PROGRESS')).toBe(false);
    expect(canRequestSaleStatus('USER', 'PAYOUT_CONFIRMED')).toBe(false);
    expect(canRequestSaleStatus('FINANCE', 'PAYMENT_CONFIRMED')).toBe(true);
  });

  it('allows the required forward path', () => {
    const path = [
      ['SALE_CREATED', 'BUYER_PENDING'],
      ['BUYER_PENDING', 'BUYER_ACCEPTED'],
      ['BUYER_ACCEPTED', 'PAYMENT_PROCESSING'],
      ['PAYMENT_PROCESSING', 'PAYMENT_CONFIRMED'],
      ['PAYMENT_CONFIRMED', 'ESCROW_HELD'],
      ['ESCROW_HELD', 'TRANSFER_PENDING'],
      ['TRANSFER_PENDING', 'TRANSFER_IN_PROGRESS'],
      ['TRANSFER_IN_PROGRESS', 'OWNERSHIP_TRANSFERRED'],
      ['OWNERSHIP_TRANSFERRED', 'HANDOVER_PENDING'],
      ['HANDOVER_PENDING', 'HANDOVER_CONFIRMED'],
      ['HANDOVER_CONFIRMED', 'PAYOUT_PROTECTION'],
      ['PAYOUT_PROTECTION', 'PAYOUT_PENDING'],
      ['PAYOUT_PENDING', 'PAYOUT_PROCESSING'],
      ['PAYOUT_PROCESSING', 'PAYOUT_CONFIRMED'],
      ['PAYOUT_CONFIRMED', 'COMPLETED'],
    ] as const;
    for (const [from, to] of path) expect(isAllowedSaleTransition(from as any, to as any)).toBe(true);
  });

  it('rejects shortcut transitions', () => {
    expect(isAllowedSaleTransition('PAYMENT_PENDING_VERIFICATION' as any, 'COMPLETED' as any)).toBe(false);
    expect(isAllowedSaleTransition('HANDOVER_PENDING' as any, 'PAYOUT_CONFIRMED' as any)).toBe(false);
    expect(isAllowedSaleTransition('BUYER_PENDING' as any, 'COMPLETED' as any)).toBe(false);
  });
});
