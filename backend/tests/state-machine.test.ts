import { describe, expect, it } from 'vitest';
import { isAllowedSaleTransition } from '../lib/transfer-workflow';

describe('Direct Sale canonical state machine', () => {
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
