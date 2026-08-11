import { Prisma } from '@prisma/client';
import { db } from './db';

type DbClient = Prisma.TransactionClient | typeof db;

/**
 * Atomic double-entry writer.
 * PostgreSQL advisory transaction locks serialize concurrent writers for the
 * same entryGroupId before checking/creating the two legs.
 */
export async function createDoubleEntry(params: {
  transactionId: string; entryGroupId: string; amount: Prisma.Decimal | number | string; currency: string;
  debitType: string; creditType: string; userId?: string; relatedOperationId?: string; providerRef?: string;
  idempotencyKey: string; metadata?: Prisma.InputJsonValue;
}, client: DbClient = db) {
  if (client === db) return db.$transaction(tx => createDoubleEntry(params, tx));

  const amount = new Prisma.Decimal(params.amount);
  if (amount.lte(0)) throw new Error('LEDGER_AMOUNT_MUST_BE_POSITIVE');
  if (params.debitType === params.creditType) throw new Error('LEDGER_SAME_ACCOUNT');

  await client.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${params.entryGroupId}))`;

  const existing = await client.financialLedger.findMany({ where: { entryGroupId: params.entryGroupId } });
  if (existing.length > 0) {
    if (existing.length !== 2) throw new Error(`LEDGER_INCOMPLETE:${params.entryGroupId}`);
    await assertLedgerBalanced(params.entryGroupId, client);
    return { replayed: true, entries: existing };
  }

  const base = {
    transactionId: params.transactionId,
    entryGroupId: params.entryGroupId,
    userId: params.userId,
    amount,
    currency: params.currency,
    relatedOperationId: params.relatedOperationId,
    providerRef: params.providerRef,
    metadata: params.metadata,
  };

  const debit = await client.financialLedger.create({
    data: { ...base, entryType: params.debitType as any, direction: 'DEBIT', idempotencyKey: `${params.idempotencyKey}:D` },
  });
  const credit = await client.financialLedger.create({
    data: { ...base, entryType: params.creditType as any, direction: 'CREDIT', idempotencyKey: `${params.idempotencyKey}:C` },
  });

  const result = { replayed: false, entries: [debit, credit] };
  await assertLedgerBalanced(params.entryGroupId, client);
  return result;
}

export async function assertLedgerBalanced(entryGroupId: string, client: DbClient = db) {
  const entries = await client.financialLedger.findMany({ where: { entryGroupId } });
  if (entries.length !== 2) throw new Error(`LEDGER_INCOMPLETE:${entryGroupId}`);
  const debit = entries.filter(e => e.direction === 'DEBIT').reduce((s, e) => s.add(e.amount), new Prisma.Decimal(0));
  const credit = entries.filter(e => e.direction === 'CREDIT').reduce((s, e) => s.add(e.amount), new Prisma.Decimal(0));
  if (!debit.eq(credit)) throw new Error(`LEDGER_UNBALANCED:${entryGroupId}`);
  return { balanced: true, debit, credit };
}
