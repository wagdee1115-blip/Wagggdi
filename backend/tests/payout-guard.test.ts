import { describe, expect, it } from 'vitest';
import { db } from '../lib/db';
import { createOwnershipTransfer } from '../lib/transfer-workflow';

// Every identifier is randomised rather than derived from Date.now().
// User.phone, Vehicle.plateNumber, Vehicle.vin and VehicleAuthorization.authorizationNumber
// are all @unique, and Vitest runs test files in parallel — timestamp-derived values
// collide with other files that use the same prefixes, which fails seeding intermittently.
let counter = 0;
function uid() {
  counter += 1;
  return `${Date.now().toString(36)}${counter}${Math.random().toString(36).slice(2, 10)}`;
}
function phone() {
  return `7${Math.floor(Math.random() * 900000000 + 100000000)}`;
}

type PayoutKind = 'NONE' | 'VALID' | 'UNVERIFIED' | 'VERIFIED_NAME_MISMATCH';

async function createPayoutAccount(userId: string, holderName: string, kind: Exclude<PayoutKind, 'NONE'>) {
  return db.payoutAccount.create({ data: {
    userId,
    provider: 'TEST_BANK',
    accountIdentifierEncrypted: 'test-encrypted',
    accountIdentifierMasked: '****0002',
    accountHolderName: holderName,
    verified: kind === 'VALID' || kind === 'VERIFIED_NAME_MISMATCH',
    nameMatchStatus: kind === 'VALID' ? 'MATCH' : 'PENDING',
    providerReference: `PG-${uid()}`,
  } });
}

/**
 * Seeds an isolated sale scenario.
 *
 * `ownerPayout` applies to the vehicle owner, `agentPayout` to the delegated
 * seller. When `delegated` is true the vehicle owner and the acting seller are
 * different users linked by a SELL_ONLY VehicleAuthorization.
 */
async function seed(opts: { ownerPayout: PayoutKind; delegated?: boolean; agentPayout?: PayoutKind }) {
  const tag = uid();
  const owner = await db.user.create({ data: { fullName: 'PG OWNER', phone: phone(), passwordHash: 'test', status: 'ACTIVE', phoneStatus: 'VERIFIED' } });
  const buyer = await db.user.create({ data: { fullName: 'PG BUYER', phone: phone(), passwordHash: 'test', status: 'ACTIVE', phoneStatus: 'VERIFIED' } });
  const agent = opts.delegated
    ? await db.user.create({ data: { fullName: 'PG AGENT', phone: phone(), passwordHash: 'test', status: 'ACTIVE', phoneStatus: 'VERIFIED' } })
    : null;

  const payoutAccounts = [];
  if (opts.ownerPayout !== 'NONE') payoutAccounts.push(await createPayoutAccount(owner.id, owner.fullName, opts.ownerPayout));
  if (agent && opts.agentPayout && opts.agentPayout !== 'NONE') payoutAccounts.push(await createPayoutAccount(agent.id, agent.fullName, opts.agentPayout));

  const vehicle = await db.vehicle.create({ data: { ownerId: owner.id, plateNumber: `PG-${tag}`, vin: `PG${tag}`.slice(0, 17), make: 'TEST', model: 'TEST', year: 2026, price: 1000000, mileage: 0, transmission: 'AUTO', fuelType: 'PETROL', color: 'WHITE', city: 'Sanaa', status: 'ACTIVE' } });

  const authorization = agent ? await db.vehicleAuthorization.create({ data: {
    authorizationNumber: `PG-AUTH-${tag}`,
    vehicleId: vehicle.id,
    ownerId: owner.id,
    authorizedUserId: agent.id,
    type: 'SELL_ONLY',
    status: 'ACTIVE',
    validUntil: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000),
    termsVersion: 'v1',
  } }) : null;

  // This test owns the exchange rate it creates and deletes only that record.
  // createOwnershipTransfer requires *some* rate to exist; it never asserts which
  // one is chosen, so a rate belonging to a parallel test file is harmless.
  const rate = await db.exchangeRate.create({ data: { usdToYer: 535, source: 'MANUAL', isAutoUpdateEnabled: false, updatedBy: owner.id, updatedByName: owner.fullName } });

  return { owner, buyer, agent, authorization, payoutAccounts, vehicle, rate };
}

async function cleanup(ctx: Awaited<ReturnType<typeof seed>>) {
  const sales = await db.vehicleSale.findMany({ where: { vehicleId: ctx.vehicle.id }, select: { id: true } });
  if (sales.length) await db.saleAuditLog.deleteMany({ where: { vehicleSaleId: { in: sales.map(x => x.id) } } });
  await db.vehicleSale.deleteMany({ where: { vehicleId: ctx.vehicle.id } });
  if (ctx.authorization) await db.vehicleAuthorization.delete({ where: { id: ctx.authorization.id } });
  await db.exchangeRateHistory.deleteMany({ where: { exchangeRateId: ctx.rate.id } });
  await db.exchangeRate.delete({ where: { id: ctx.rate.id } });
  await db.vehicle.delete({ where: { id: ctx.vehicle.id } });
  for (const account of ctx.payoutAccounts) await db.payoutAccount.delete({ where: { id: account.id } });
  const userIds = [ctx.owner.id, ctx.buyer.id, ...(ctx.agent ? [ctx.agent.id] : [])];
  await db.user.deleteMany({ where: { id: { in: userIds } } });
}

async function expectNoSideEffects(ctx: Awaited<ReturnType<typeof seed>>) {
  const vehicle = await db.vehicle.findUniqueOrThrow({ where: { id: ctx.vehicle.id } });
  expect(vehicle.status).toBe('ACTIVE');
  expect(vehicle.isReserved).toBe(false);
  expect(await db.vehicleSale.count({ where: { vehicleId: ctx.vehicle.id } })).toBe(0);
  expect(await db.salePayment.count({ where: { vehicleSale: { vehicleId: ctx.vehicle.id } } })).toBe(0);
  const userIds = [ctx.owner.id, ctx.buyer.id, ...(ctx.agent ? [ctx.agent.id] : [])];
  expect(await db.financialLedger.count({ where: { userId: { in: userIds } } })).toBe(0);
}

describe('Payout account guard on sale creation', () => {
  it('rejects sale when seller has no payout account, without side effects', async () => {
    if (!process.env.DATABASE_URL) throw new Error('BLOCKED:POSTGRESQL_REQUIRED');
    const ctx = await seed({ ownerPayout: 'NONE' });
    try {
      await expect(createOwnershipTransfer({ vehicleId: ctx.vehicle.id, sellerId: ctx.owner.id, buyerId: ctx.buyer.id, salePrice: 1000000 }))
        .rejects.toThrow('PAYOUT_ACCOUNT_REQUIRED');
      await expectNoSideEffects(ctx);
    } finally {
      await cleanup(ctx);
    }
  });

  it('rejects sale when payout account exists but is not verified/matched', async () => {
    if (!process.env.DATABASE_URL) throw new Error('BLOCKED:POSTGRESQL_REQUIRED');
    const ctx = await seed({ ownerPayout: 'UNVERIFIED' });
    try {
      await expect(createOwnershipTransfer({ vehicleId: ctx.vehicle.id, sellerId: ctx.owner.id, buyerId: ctx.buyer.id, salePrice: 1000000 }))
        .rejects.toThrow('PAYOUT_ACCOUNT_REQUIRED');
      await expectNoSideEffects(ctx);
    } finally {
      await cleanup(ctx);
    }
  });

  it('rejects sale with PAYOUT_REVIEW_REQUIRED when account is verified but name not matched', async () => {
    if (!process.env.DATABASE_URL) throw new Error('BLOCKED:POSTGRESQL_REQUIRED');
    const ctx = await seed({ ownerPayout: 'VERIFIED_NAME_MISMATCH' });
    try {
      await expect(createOwnershipTransfer({ vehicleId: ctx.vehicle.id, sellerId: ctx.owner.id, buyerId: ctx.buyer.id, salePrice: 1000000 }))
        .rejects.toThrow('PAYOUT_REVIEW_REQUIRED');
      await expectNoSideEffects(ctx);
    } finally {
      await cleanup(ctx);
    }
  });

  it('allows sale when seller has a verified, name-matched payout account', async () => {
    if (!process.env.DATABASE_URL) throw new Error('BLOCKED:POSTGRESQL_REQUIRED');
    const ctx = await seed({ ownerPayout: 'VALID' });
    try {
      const sale = await createOwnershipTransfer({ vehicleId: ctx.vehicle.id, sellerId: ctx.owner.id, buyerId: ctx.buyer.id, salePrice: 1000000 });
      expect(sale.id).toBeTruthy();
      expect(sale.payoutUserId).toBe(ctx.owner.id);
      const vehicle = await db.vehicle.findUniqueOrThrow({ where: { id: ctx.vehicle.id } });
      expect(vehicle.isReserved).toBe(true);
      expect(vehicle.status).toBe('PENDING');
    } finally {
      await cleanup(ctx);
    }
  });
});

describe('Payout account guard under SELL_ONLY delegation', () => {
  it('allows the sale when the vehicle owner holds the payout account, even though the delegated seller holds none', async () => {
    if (!process.env.DATABASE_URL) throw new Error('BLOCKED:POSTGRESQL_REQUIRED');
    const ctx = await seed({ ownerPayout: 'VALID', delegated: true, agentPayout: 'NONE' });
    const agent = ctx.agent!;
    try {
      // 1. the delegated seller is authorized
      expect(ctx.authorization!.type).toBe('SELL_ONLY');
      expect(ctx.authorization!.status).toBe('ACTIVE');
      expect(ctx.authorization!.authorizedUserId).toBe(agent.id);
      // 2 + 3. the only payout account belongs to the owner and is verified + name-matched
      expect(await db.payoutAccount.count({ where: { userId: agent.id } })).toBe(0);
      const ownerAccount = await db.payoutAccount.findFirstOrThrow({ where: { userId: ctx.owner.id } });
      expect(ownerAccount.verified).toBe(true);
      expect(ownerAccount.nameMatchStatus).toBe('MATCH');

      // 4. sale creation succeeds with the agent acting as seller
      const sale = await createOwnershipTransfer({ vehicleId: ctx.vehicle.id, sellerId: agent.id, buyerId: ctx.buyer.id, salePrice: 1000000 });
      expect(sale.id).toBeTruthy();
      expect(sale.sellerId).toBe(agent.id);

      // 5. proceeds are routed to the owner, never to the delegated seller
      expect(sale.payoutUserId).toBe(ctx.owner.id);
      expect(sale.payoutUserId).not.toBe(agent.id);

      const vehicle = await db.vehicle.findUniqueOrThrow({ where: { id: ctx.vehicle.id } });
      expect(vehicle.isReserved).toBe(true);
      expect(vehicle.status).toBe('PENDING');
    } finally {
      await cleanup(ctx);
    }
  });

  it("rejects the sale when the owner has no payout account, even if the delegated seller has a valid one", async () => {
    if (!process.env.DATABASE_URL) throw new Error('BLOCKED:POSTGRESQL_REQUIRED');
    const ctx = await seed({ ownerPayout: 'NONE', delegated: true, agentPayout: 'VALID' });
    const agent = ctx.agent!;
    try {
      const agentAccount = await db.payoutAccount.findFirstOrThrow({ where: { userId: agent.id } });
      expect(agentAccount.verified).toBe(true);
      expect(agentAccount.nameMatchStatus).toBe('MATCH');
      expect(await db.payoutAccount.count({ where: { userId: ctx.owner.id } })).toBe(0);

      // The delegated seller's own account must not stand in for the owner's.
      await expect(createOwnershipTransfer({ vehicleId: ctx.vehicle.id, sellerId: agent.id, buyerId: ctx.buyer.id, salePrice: 1000000 }))
        .rejects.toThrow('PAYOUT_ACCOUNT_REQUIRED');
      await expectNoSideEffects(ctx);
    } finally {
      await cleanup(ctx);
    }
  });
});
