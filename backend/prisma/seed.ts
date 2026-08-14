import { PrismaClient } from '@prisma/client';
import bcrypt from 'bcryptjs';

const db = new PrismaClient();

async function main() {
  if (process.env.NODE_ENV === 'production') throw new Error('Do not run seed in production');
  if (process.env.ALLOW_DEMO_SEED !== 'I_UNDERSTAND_DEMO_DATA') throw new Error('Set ALLOW_DEMO_SEED=I_UNDERSTAND_DEMO_DATA to seed an isolated local/test database');
  const seedPassword = process.env.SEED_ADMIN_PASSWORD?.trim();
  if (!seedPassword || seedPassword.length < 12) throw new Error('SEED_ADMIN_PASSWORD must contain at least 12 characters');
  console.log('Seeding مركبات - بيانات تجريبية يمنية (لا يوجد ربط رسمي)');

  const hash = await bcrypt.hash(seedPassword, 12);

  const admin = await db.user.upsert({
    where: { nationalId: '1000000001' },
    update: { role: 'OWNER', status: 'ACTIVE', identityStatus: 'VERIFIED', phoneStatus: 'VERIFIED' },
    create: {
      fullName: 'مالك منصة مركبات (تجريبي)',
      nationalId: '1000000001',
      dateOfBirth: new Date('1990-01-01'),
      phone: '777000001',
      email: 'admin@markabat.ye',
      passwordHash: hash,
      role: 'OWNER',
      status: 'ACTIVE',
      identityStatus: 'VERIFIED',
      phoneStatus: 'VERIFIED',
    },
  });

  const demoRoles = ['SELLER', 'SELLER', 'BUYER', 'DEALER', 'USER'] as const;
  const users = [];
  for (let i = 1; i <= 5; i++) {
    const u = await db.user.upsert({
      where: { nationalId: `100000000${i+1}` },
      update: { role: demoRoles[i - 1], status: 'ACTIVE', identityStatus: 'VERIFIED', phoneStatus: 'VERIFIED' },
      create: {
        fullName: `مستخدم تجريبي ${i}`,
        nationalId: `100000000${i+1}`,
        dateOfBirth: new Date(1990+i, 1, 1),
        phone: `77700000${i+1}`,
        email: `user${i}@test.ye`,
        passwordHash: hash,
        role: demoRoles[i - 1],
        status: 'ACTIVE',
        identityStatus: 'VERIFIED',
        phoneStatus: 'VERIFIED',
      }
    });
    users.push(u);
  }

  // Traffic Services
  const services = ['نقل الملكية','تجديد الاستمارة','الاستعلام عن المخالفات','حجز موعد','الفحص الدوري'];
  for (const name of services) {
    await db.trafficService.upsert({
      where: { id: name },
      update: {},
      create: { id: name, name, description: name, type: name, requiresIdentity: true }
    });
  }

  // Vehicles
  const makes = [
    ['تويوتا','كامري'], ['هونداي','النترا'], ['كيا','سورينتو'],
    ['نيسان','باترول'], ['لكزس','LX 570'], ['بي إم دبليو','740Li'],
  ];
  const vehicles = [];
  for (let i=0;i<makes.length;i++) {
    const [make,model] = makes[i];
    const v = await db.vehicle.upsert({
      where: { plateNumber: `يمن-${1000+i}` },
      update: {},
      create: {
        ownerId: users[i % users.length].id,
        plateNumber: `يمن-${1000+i}`,
        vin: `VINYEMEN00000000${i}123`,
        make, model, year: 2020+i,
        price: 5000000 + i*1000000,
        mileage: 30000 + i*5000,
        transmission: 'AUTO',
        fuelType: 'PETROL',
        color: ['أبيض','أسود','فضي','أزرق'][i],
        city: ['صنعاء','عدن','تعز','حضرموت'][i],
        status: i === 4 ? 'SOLD' : 'ACTIVE',
        governmentStatus: 'VERIFIED',
      }
    });
    vehicles.push(v);
    await db.vehicleOwnership.upsert({ where: { id: `seed-owner-${i}` }, update: {}, create: { id: `seed-owner-${i}`, vehicleId: v.id, ownerId: v.ownerId, ownershipStatus: 'ACTIVE' } });
    if (!(await db.vehicleInsurance.findFirst({ where: { vehicleId: v.id, policyNumber: `POL-${i}` } }))) await db.vehicleInsurance.create({ data: { vehicleId: v.id, provider: 'DEMO_SEED', policyNumber: `POL-${i}`, status: 'VALID', startDate: new Date(), endDate: new Date(Date.now()+365*24*3600*1000) } });
    if (!(await db.vehicleInspection.findFirst({ where: { vehicleId: v.id, inspectionNumber: `INSP-${i}` } }))) await db.vehicleInspection.create({ data: { vehicleId: v.id, provider: 'DEMO_SEED', inspectionNumber: `INSP-${i}`, status: 'VALID', inspectionDate: new Date(), expiryDate: new Date(Date.now()+180*24*3600*1000), result: 'PASS' } });
  }

  let exchangeRate = await db.exchangeRate.findFirst({ orderBy: { createdAt: 'asc' } });
  if (!exchangeRate) exchangeRate = await db.exchangeRate.create({ data: { usdToYer: 535, source: 'MANUAL', updatedBy: admin.id, updatedByName: admin.fullName } });

  // Public market cards. Sold/reserved scenario vehicles remain out of the active market.
  for (const i of [0, 2, 3, 5]) {
    await db.vehicleListing.upsert({
      where: { id: `seed-listing-${i}` },
      update: { status: 'ACTIVE', price: vehicles[i].price, source: 'GOVERNMENT_DEMO' },
      create: {
        id: `seed-listing-${i}`,
        vehicleId: vehicles[i].id,
        creatorId: vehicles[i].ownerId,
        listingType: i === 3 ? 'EXHIBITION' : 'MARKET',
        status: 'ACTIVE',
        price: vehicles[i].price,
        currency: 'YER',
        source: 'GOVERNMENT_DEMO',
        aiDescription: `${vehicles[i].make} ${vehicles[i].model} بحالة تجريبية للعرض الحكومي؛ لا يمثل هذا الإعلان مركبة حقيقية.`,
      },
    });
  }

  // A live auction with anonymous bidder presentation data.
  const auction = await db.auction.upsert({
    where: { id: 'seed-auction-live' },
    update: { status: 'ACTIVE', endAt: new Date(Date.now() + 2 * 60 * 60 * 1000) },
    create: {
      id: 'seed-auction-live',
      vehicleId: vehicles[3].id,
      sellerId: vehicles[3].ownerId,
      startingPrice: 8_000_000,
      currentPrice: 8_250_000,
      minimumIncrement: 50_000,
      startAt: new Date(Date.now() - 30 * 60 * 1000),
      endAt: new Date(Date.now() + 2 * 60 * 60 * 1000),
      status: 'ACTIVE',
      bidDepositAmount: 100_000,
    },
  });
  await db.auctionBid.upsert({
    where: { id: 'seed-auction-bid-1' },
    update: { amount: 8_250_000 },
    create: { id: 'seed-auction-bid-1', auctionId: auction.id, bidderId: users[2].id, amount: 8_250_000, idempotencyKey: 'seed-auction-bid-1' },
  });

  const saleBase = {
    exchangeRate: exchangeRate.usdToYer,
    exchangeRateId: exchangeRate.id,
    transferFeeUSD: 80,
    transferFeeYER: 42_800,
    platformFeeUSD: 0,
    platformFeeYER: 0,
    listingCommissionUSD: 0,
    auctionFeeYER: 0,
    governmentFeesYER: 0,
    bidDepositYER: 0,
    platformRevenueYER: 42_800,
  } as const;

  // Scenario 1: completed transfer with an immutable demo contract.
  const completedSale = await db.vehicleSale.upsert({
    where: { id: 'seed-sale-completed' },
    update: { status: 'COMPLETED' },
    create: {
      id: 'seed-sale-completed', vehicleId: vehicles[4].id,
      sellerId: users[4].id, sellerName: users[4].fullName, sellerNationalId: users[4].nationalId!, sellerPhone: users[4].phone, sellerVerified: true,
      buyerId: users[2].id, buyerName: users[2].fullName, buyerNationalId: users[2].nationalId!, buyerPhone: users[2].phone, buyerVerified: true, buyerApproved: true,
      vehicleAmountYER: 12_000_000, totalPaidYER: 12_042_800, sellerPayoutYER: 12_000_000,
      paymentVerified: true, fundsSecured: true, buyerOtpVerified: true, sellerOtpVerified: true,
      governmentReference: 'DEMO-GOV-TRANSFER-001', governmentStatus: 'SANDBOX_APPROVED', status: 'COMPLETED',
      statusHistory: [{ event: 'COMPLETED', at: new Date().toISOString(), actorId: 'DEMO_SYSTEM' }],
      expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000), ...saleBase,
    },
  });
  const contract = await db.saleContract.upsert({
    where: { vehicleSaleId: completedSale.id },
    update: { status: 'SIGNED_DEMO' },
    create: {
      id: 'seed-contract-completed', vehicleSaleId: completedSale.id, contractNumber: 'DEMO-CONTRACT-2026-001', operationId: completedSale.id,
      contractData: { environment: 'GOVERNMENT_DEMO', disclaimer: 'مركبات وسيط تقني — هذا عقد تجريبي غير نافذ.' }, status: 'SIGNED_DEMO',
    },
  });
  await db.vehicleSale.update({ where: { id: completedSale.id }, data: { contractId: contract.id } });

  // Scenario 2: buyer accepted and is waiting for provider payment.
  await db.vehicleSale.upsert({
    where: { id: 'seed-sale-waiting-payment' },
    update: { status: 'WAITING_PAYMENT' },
    create: {
      id: 'seed-sale-waiting-payment', vehicleId: vehicles[1].id,
      sellerId: users[1].id, sellerName: users[1].fullName, sellerNationalId: users[1].nationalId!, sellerPhone: users[1].phone, sellerVerified: true,
      buyerId: users[2].id, buyerName: users[2].fullName, buyerNationalId: users[2].nationalId!, buyerPhone: users[2].phone, buyerVerified: true, buyerApproved: true,
      vehicleAmountYER: 6_000_000, totalPaidYER: 6_042_800, sellerPayoutYER: 6_000_000,
      status: 'WAITING_PAYMENT', statusHistory: [{ event: 'WAITING_PAYMENT', at: new Date().toISOString(), actorId: users[2].id }],
      expiresAt: new Date(Date.now() + 2 * 60 * 60 * 1000), ...saleBase,
    },
  });
  await db.vehicle.update({ where: { id: vehicles[1].id }, data: { isReserved: true, status: 'PENDING' } });

  // Scenario 3: payment was safely returned after an incomplete transfer.
  await db.vehicleSale.upsert({
    where: { id: 'seed-sale-refunded' },
    update: { status: 'REFUNDED' },
    create: {
      id: 'seed-sale-refunded', vehicleId: vehicles[5].id,
      sellerId: users[0].id, sellerName: users[0].fullName, sellerNationalId: users[0].nationalId!, sellerPhone: users[0].phone, sellerVerified: true,
      buyerId: users[1].id, buyerName: users[1].fullName, buyerNationalId: users[1].nationalId!, buyerPhone: users[1].phone, buyerVerified: true, buyerApproved: true,
      vehicleAmountYER: 9_000_000, totalPaidYER: 9_042_800, sellerPayoutYER: 9_000_000,
      paymentVerified: true, fundsSecured: false, status: 'REFUNDED', refundProviderReference: 'DEMO-REFUND-001', refundIdempotencyKey: 'seed-refund-001',
      refundReason: 'انتهت المهلة قبل اكتمال نقل الملكية — سيناريو تجريبي', refundedAt: new Date(),
      statusHistory: [{ event: 'REFUNDED', at: new Date().toISOString(), actorId: 'DEMO_SYSTEM' }],
      expiresAt: new Date(Date.now() - 60 * 60 * 1000), ...saleBase,
    },
  });

  await db.notification.upsert({
    where: { id: 'seed-notification-buyer' },
    update: { isRead: false },
    create: { id: 'seed-notification-buyer', userId: users[2].id, type: 'DEMO_TRANSFER', title: 'طلب نقل ملكية تجريبي', message: 'لديك عملية بانتظار الدفع في بيئة العرض الحكومي.', priority: 'HIGH', operationId: 'seed-sale-waiting-payment', data: { demo: true } },
  });
  await db.supportTicket.upsert({
    where: { ticketNumber: 'DEMO-2026-001' },
    update: { status: 'IN_PROGRESS' },
    create: { id: 'seed-support-ticket', ticketNumber: 'DEMO-2026-001', userId: users[2].id, category: 'OWNERSHIP_TRANSFER', subject: 'استفسار عن حالة نقل الملكية', description: 'تذكرة تجريبية لعرض مسار الدعم داخل المعاملة.', status: 'IN_PROGRESS', priority: 'NORMAL' },
  });

  // Integrations
  const providers = ['IDENTITY','PHONE','VEHICLE','INSURANCE','INSPECTION','VIOLATION','APPOINTMENT','BANK','PAYMENT'];
  for (const p of providers) {
    await db.integrationStatus.upsert({ where: { providerName: p }, update: { status: 'NOT_CONFIGURED' }, create: { providerName: p, providerType: p, status: 'NOT_CONFIGURED' } });
  }

  // Seeded fees do not have a database unique key, so serialize and reconcile them explicitly.
  const seededFees = [
    { serviceType: 'OWNERSHIP_TRANSFER', name: 'رسوم نقل الملكية (تجريبية)', amount: 5000 },
    { serviceType: 'RENEWAL', name: 'رسوم التجديد (تجريبية)', amount: 3000 },
  ];
  await db.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext('markabat:seed:fees'))`;
    for (const fee of seededFees) {
      const existing = await tx.fee.findMany({
        where: { serviceType: fee.serviceType, name: fee.name },
        orderBy: { id: 'asc' },
        select: { id: true },
      });
      if (existing.length === 0) {
        await tx.fee.create({ data: fee });
        continue;
      }
      await tx.fee.update({ where: { id: existing[0].id }, data: { amount: fee.amount, currency: 'YER', status: 'ACTIVE' } });
      if (existing.length > 1) await tx.fee.deleteMany({ where: { id: { in: existing.slice(1).map(({ id }) => id) } } });
    }
  });

  console.log('✅ Seed completed - كل البيانات تجريبية');
}

main().finally(()=>db.$disconnect());
