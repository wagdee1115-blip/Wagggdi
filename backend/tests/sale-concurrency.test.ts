import { describe, expect, it } from 'vitest';
import { db } from '../lib/db';
import { createOwnershipTransfer } from '../lib/transfer-workflow';

describe('Direct sale PostgreSQL concurrency',()=>{
  it('permits one sale lock winner only', async()=>{
    if(!process.env.DATABASE_URL) throw new Error('BLOCKED:POSTGRESQL_REQUIRED');
    const s=String(Date.now());
    const seller=await db.user.create({data:{fullName:'SALE SELLER',phone:`774${s.slice(-7)}`,passwordHash:'test',status:'ACTIVE',phoneStatus:'VERIFIED'}});
    const buyerA=await db.user.create({data:{fullName:'BUYER A',phone:`773${s.slice(-7)}`,passwordHash:'test',status:'ACTIVE',phoneStatus:'VERIFIED'}});
    const buyerB=await db.user.create({data:{fullName:'BUYER B',phone:`772${s.slice(-7)}`,passwordHash:'test',status:'ACTIVE',phoneStatus:'VERIFIED'}});
    const vehicle=await db.vehicle.create({data:{ownerId:seller.id,plateNumber:`S-${s.slice(-10)}`,vin:`SALE${s}`.slice(0,17),make:'TEST',model:'TEST',year:2026,price:1000000,mileage:0,transmission:'AUTO',fuelType:'PETROL',color:'WHITE',city:'Sanaa',status:'ACTIVE'}});
    const rate=await db.exchangeRate.create({data:{usdToYer:535,source:'MANUAL',isAutoUpdateEnabled:false,updatedBy:seller.id,updatedByName:seller.fullName}});
    try{
      const results=await Promise.allSettled([
        createOwnershipTransfer({vehicleId:vehicle.id,sellerId:seller.id,buyerId:buyerA.id,salePrice:1000000}),
        createOwnershipTransfer({vehicleId:vehicle.id,sellerId:seller.id,buyerId:buyerB.id,salePrice:1000000}),
      ]);
      expect(results.filter(r=>r.status==='fulfilled')).toHaveLength(1);
      expect(await db.vehicleSale.count({where:{vehicleId:vehicle.id}})).toBe(1);
      const v=await db.vehicle.findUniqueOrThrow({where:{id:vehicle.id}});expect(v.isReserved).toBe(true);
    } finally {
      await db.vehicleSale.deleteMany({where:{vehicleId:vehicle.id}});
      await db.exchangeRateHistory.deleteMany({where:{exchangeRateId:rate.id}});
      await db.exchangeRate.delete({where:{id:rate.id}});
      await db.vehicle.delete({where:{id:vehicle.id}});
      await db.user.deleteMany({where:{id:{in:[seller.id,buyerA.id,buyerB.id]}}});
    }
  });
});
