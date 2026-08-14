import { z } from 'zod';
import { db } from '@/lib/db';
import { getCurrentUser, apiError, safeApiErrorCode } from '@/lib/api-auth';
import { createVehicleAuction } from '@/lib/auction';
import { isIdentityVerified } from '@/lib/identity-policy';
import type { Prisma } from '@prisma/client';

const createSchema = z.object({
  vehicleId:z.string().min(1),
  startingPrice:z.number().min(50000),
  minimumIncrement:z.number().positive().default(1000),
  bidDepositAmount:z.number().nonnegative().optional(),
  startAt:z.string().datetime().optional(),
  endAt:z.string().datetime(),
}).superRefine((value, context) => {
  if (value.bidDepositAmount && value.bidDepositAmount > value.startingPrice) {
    context.addIssue({ code: 'custom', path: ['bidDepositAmount'], message: 'BID_DEPOSIT_EXCEEDS_STARTING_PRICE' });
  }
});

export async function GET(req:Request) {
  try {
    const url=new URL(req.url);
    const make=url.searchParams.get('make')||undefined;
    const model=url.searchParams.get('model')||undefined;
    const year=url.searchParams.get('year');
    const tab=url.searchParams.get('tab')||'live';
    const now=new Date();
    const timing: Prisma.AuctionWhereInput = tab === 'upcoming'
      ? { status: 'ACTIVE' as const, startAt: { gt: now } }
      : tab === 'ended'
        ? { OR: [{ status: { in: ['ENDED','SOLD','CANCELLED'] } }, { endAt: { lte: now } }] }
        : { status: 'ACTIVE' as const, startAt: { lte: now }, endAt: { gt: now } };
    const auctions=await db.auction.findMany({
      where:{
        ...timing,
        ...(make||model||year ? { vehicle: {
          ...(make ? {make:{equals:make,mode:'insensitive'}} : {}),
          ...(model ? {model:{equals:model,mode:'insensitive'}} : {}),
          ...(year ? {year:Number(year)} : {}),
        }} : {}),
      },
      select:{
        id:true,startingPrice:true,currentPrice:true,minimumIncrement:true,startAt:true,endAt:true,
        status:true,bidDepositAmount:true,bidDepositCurrency:true,createdAt:true,
        vehicle:{select:{make:true,model:true,year:true,price:true,mileage:true,transmission:true,fuelType:true,color:true,city:true}},
      },
      orderBy:{endAt:'asc'},
      take:100,
    });
    return Response.json({ok:true,auctions});
  } catch(e){return apiError(e);}
}

export async function POST(req:Request) {
  try {
    const user=await getCurrentUser();
    if(!user) return Response.json({ok:false,error:'UNAUTHORIZED'},{status:401});
    if(user.status!=='ACTIVE') return Response.json({ok:false,error:'ACCOUNT_NOT_ACTIVE'},{status:403});
    if(user.phoneStatus!=='VERIFIED') return Response.json({ok:false,error:'PHONE_NOT_VERIFIED'},{status:409});
    if(!isIdentityVerified(user)) return Response.json({ok:false,error:'IDENTITY_NOT_VERIFIED'},{status:409});
    const parsed=createSchema.safeParse(await req.json());
    if(!parsed.success) return Response.json({ok:false,error:'INVALID_INPUT',details:parsed.error.flatten()},{status:400});
    const p=parsed.data;
    const auction=await createVehicleAuction({
      vehicleId:p.vehicleId,
      actorId:user.id,
      startingPrice:p.startingPrice,
      minimumIncrement:p.minimumIncrement,
      bidDepositAmount:p.bidDepositAmount,
      startAt:p.startAt?new Date(p.startAt):undefined,
      endAt:new Date(p.endAt),
    });
    return Response.json({ok:true,auction},{status:201});
  } catch(e){
    const error=safeApiErrorCode(e);
    const status=error==='VEHICLE_NOT_FOUND'?404
      : error==='NOT_OWNER'?403
        : error==='INVALID_AUCTION_WINDOW'||error.startsWith('INVALID_')?400
          : error==='INTERNAL_ERROR'?500:409;
    return Response.json({ok:false,error},{status});
  }
}
