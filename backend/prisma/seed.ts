import { PrismaClient } from '@prisma/client';
import bcrypt from 'bcryptjs';

const db = new PrismaClient();

async function main() {
  console.log('Seeding مركبات - بيانات تجريبية يمنية (لا يوجد ربط رسمي)');

  const seedPassword = process.env.SEED_ADMIN_PASSWORD || 'ChangeMe-LocalOnly-123!';
  if (process.env.NODE_ENV === 'production') throw new Error('Do not run seed in production');
  const hash = await bcrypt.hash(seedPassword, 12);

  const admin = await db.user.upsert({
    where: { nationalId: '1000000001' },
    update: {},
    create: {
      fullName: 'مدير النظام',
      nationalId: '1000000001',
      dateOfBirth: new Date('1990-01-01'),
      phone: '777000001',
      email: 'admin@markabat.ye',
      passwordHash: hash,
      role: 'ADMIN',
      status: 'ACTIVE',
      identityStatus: 'VERIFIED',
      phoneStatus: 'VERIFIED',
    },
  });

  const users = [];
  for (let i = 1; i <= 5; i++) {
    const u = await db.user.upsert({
      where: { nationalId: `100000000${i+1}` },
      update: {},
      create: {
        fullName: `مستخدم تجريبي ${i}`,
        nationalId: `100000000${i+1}`,
        dateOfBirth: new Date(1990+i, 1, 1),
        phone: `77700000${i+1}`,
        email: `user${i}@test.ye`,
        passwordHash: hash,
        role: 'USER',
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
  const makes = [['تويوتا','كامري'],['هونداي','النترا'],['كيا','سورينتو'],['نيسان','باترول']];
  for (let i=0;i<4;i++) {
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
        status: 'ACTIVE',
        governmentStatus: 'VERIFIED',
      }
    });
    await db.vehicleOwnership.upsert({ where: { id: `seed-owner-${i}` }, update: {}, create: { id: `seed-owner-${i}`, vehicleId: v.id, ownerId: v.ownerId, ownershipStatus: 'ACTIVE' } });
    if (!(await db.vehicleInsurance.findFirst({ where: { vehicleId: v.id, policyNumber: `POL-${i}` } }))) await db.vehicleInsurance.create({ data: { vehicleId: v.id, provider: 'MOCK', policyNumber: `POL-${i}`, status: 'VALID', startDate: new Date(), endDate: new Date(Date.now()+365*24*3600*1000) } });
    if (!(await db.vehicleInspection.findFirst({ where: { vehicleId: v.id, inspectionNumber: `INSP-${i}` } }))) await db.vehicleInspection.create({ data: { vehicleId: v.id, provider: 'MOCK', inspectionNumber: `INSP-${i}`, status: 'VALID', inspectionDate: new Date(), expiryDate: new Date(Date.now()+180*24*3600*1000), result: 'PASS' } });
  }

  if (!(await db.exchangeRate.findFirst())) await db.exchangeRate.create({ data: { usdToYer: 535, source: 'MANUAL', updatedBy: admin.id, updatedByName: admin.fullName } });

  // Integrations
  const providers = ['IDENTITY','PHONE','VEHICLE','INSURANCE','INSPECTION','VIOLATION','APPOINTMENT','BANK','PAYMENT'];
  for (const p of providers) {
    await db.integrationStatus.upsert({ where: { providerName: p }, update: { status: 'NOT_CONFIGURED' }, create: { providerName: p, providerType: p, status: 'NOT_CONFIGURED' } });
  }

  // Fees mock
  await db.fee.createMany({ data: [
    { serviceType: 'OWNERSHIP_TRANSFER', name: 'رسوم نقل الملكية (تجريبية)', amount: 5000 },
    { serviceType: 'RENEWAL', name: 'رسوم التجديد (تجريبية)', amount: 3000 },
  ], skipDuplicates: true });

  console.log('✅ Seed completed - كل البيانات تجريبية');
}

main().finally(()=>db.$disconnect());
