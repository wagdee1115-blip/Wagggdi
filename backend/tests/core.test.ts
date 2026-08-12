import { describe, expect, it } from 'vitest';
import { registerSchema, vehicleSchema } from '../lib/validations';
import { calculateAuctionFeeYer, calculateListingCommissionUsd, FEES } from '../lib/fees';

const invoice = (vehicle:number, rate:number, listingUsd:number, auctionFee:number) => {
  const transfer = FEES.TRANSFER_USD * rate;
  const listing = listingUsd * rate;
  return { total: vehicle + transfer + listing + auctionFee, sellerPayout: vehicle };
};

describe('Markabat final fee rules', () => {
  it('direct market has no listing commission and 80 USD transfer', () => {
    expect(calculateListingCommissionUsd('DIRECT_MARKET', true)).toBe(0);
    expect(invoice(10_000_000,535,0,0)).toEqual({total:10_042_800,sellerPayout:10_000_000});
  });
  it('exhibition applies exactly 100 USD only when sold through the service', () => {
    expect(calculateListingCommissionUsd('EXHIBITION', true)).toBe(100);
    expect(calculateListingCommissionUsd('EXHIBITION', false)).toBe(0);
  });
  it('auction is 2.5 percent plus independent 80 USD transfer when applicable', () => {
    expect(calculateAuctionFeeYer(10_000_000)).toBe(250_000);
    expect(invoice(10_000_000,535,0,250_000)).toEqual({total:10_292_800,sellerPayout:10_000_000});
  });
  it('tax is currently zero',()=>expect(FEES.TAX_PERCENT).toBe(0));
  it('registration accepts optional email and national id',()=>expect(registerSchema.safeParse({fullName:'Test User',phone:'777000001',password:'password123'}).success).toBe(true));
  it('vehicle schema remains valid',()=>expect(vehicleSchema.safeParse({plateNumber:'123',vin:'123456789012',make:'Toyota',model:'Camry',year:2024,price:1000000,mileage:10000,transmission:'AUTO',fuelType:'PETROL',color:'White',city:'Sanaa'}).success).toBe(true));
});
