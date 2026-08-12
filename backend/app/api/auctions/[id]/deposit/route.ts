import { z } from 'zod';
import { db } from '@/lib/db';
import { getCurrentUser } from '@/lib/api-auth';
import { Prisma } from '@prisma/client';
import { createDoubleEntry } from '@/lib/ledger';

const schema = z.object({ idempotencyKey: z.string().min(8) });

export async function POST(req: Request, { params }: { params: { id: string } }) {
  try {
    const user = await getCurrentUser();
    if (!user || user.status !== 'ACTIVE') return Response.json({ ok: false, error: 'UNAUTHORIZED' }, { status: 401 });
    const p = schema.safeParse(await req.json()); if (!p.success) return Response.json({ ok: false, error: 'INVALID_INPUT' }, { status: 400 });
    const auction = await db.auction.findUnique({ where: { id: params.id } }); if (!auction) return Response.json({ ok: false, error: 'AUCTION_NOT_FOUND' }, { status: 404 });
    if (auction.sellerId === user.id) return Response.json({ ok: false, error: 'SELLER_CANNOT_DEPOSIT' }, { status: 409 });
    if (!auction.bidDepositAmount || new Prisma.Decimal(auction.bidDepositAmount).lte(0)) return Response.json({ ok: false, error: 'DEPOSIT_NOT_REQUIRED' }, { status: 409 });
    const existing = await db.auctionBidDeposit.findUnique({ where: { idempotencyKey: p.data.idempotencyKey } }); if (existing) return Response.json({ ok: true, deposit: existing, replayed: true });
    const active = await db.auctionBidDeposit.findFirst({ where: { auctionId: auction.id, bidderId: user.id, status: 'HOLD' } }); if (active) return Response.json({ ok: true, deposit: active, replayed: true });

    const providerUrl = process.env.AUCTION_DEPOSIT_PROVIDER_URL; const secret = process.env.AUCTION_DEPOSIT_PROVIDER_SECRET;
    if (!providerUrl || !secret) return Response.json({ ok: false, error: 'NOT_CONFIGURED:AUCTION_DEPOSIT_PROVIDER_REQUIRED' }, { status: 503 });
    const response = await fetch(providerUrl, { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${secret}` }, body: JSON.stringify({ auctionId: auction.id, bidderId: user.id, amount: auction.bidDepositAmount, currency: auction.bidDepositCurrency, idempotencyKey: p.data.idempotencyKey }) });
    if (!response.ok) return Response.json({ ok: false, error: 'BID_DEPOSIT_PROVIDER_FAILED' }, { status: 502 });
    const result = await response.json() as { status?: string; providerReference?: string };
    if (result.status !== 'HOLD' || !result.providerReference) return Response.json({ ok: false, error: 'BID_DEPOSIT_NOT_HELD' }, { status: 502 });

    const deposit = await db.$transaction(async tx => {
      const created = await tx.auctionBidDeposit.create({ data: { auctionId: auction.id, bidderId: user.id, amount: auction.bidDepositAmount!, currency: auction.bidDepositCurrency, status: 'HOLD', providerReference: result.providerReference, idempotencyKey: p.data.idempotencyKey } });
      await createDoubleEntry({ transactionId: auction.id, entryGroupId: `BID_DEPOSIT:${created.id}`, amount: created.amount, currency: created.currency, debitType: 'CUSTOMER_FUNDS', creditType: 'ESCROW_FUNDS', userId: user.id, relatedOperationId: auction.id, providerRef: result.providerReference, idempotencyKey: `BID_DEPOSIT:${created.id}` }, tx);
      return created;
    });
    return Response.json({ ok: true, deposit });
  } catch (e) {
    return Response.json({ ok: false, error: e instanceof Error ? e.message : 'BID_DEPOSIT_FAILED' }, { status: 400 });
  }
}
