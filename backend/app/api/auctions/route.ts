import { z } from 'zod';
import { db } from '@/lib/db';
import { getCurrentUser, apiError } from '@/lib/api-auth';

const createSchema = z.object({
  vehicleId:z.string().min(1),
  startingPrice:z.number().min(50000),
  minimumIncrement:z.number().positive().default(1000),
  bidDepositAmount:z.number().nonnegative().optional(),
  startAt:z.string().datetime().optional(),
  endAt:z.string().datetime(),
});

export async function GET(req:Request) {
  try {
    const url=new URL(req.url);
    const make=url.searchParams.get('make')||undefined;
    const model=url.searchParams.get('model')||undefined;
    const year=url.searchParams.get('year');
    const auctions=await db.auction.findMany({
      where:{
        status:'ACTIVE',
        ...(make||model||year ? { vehicle: {
          ...(make ? {make:{equals:make,mode:'insensitive'}} : {}),
          ...(model ? {model:{equals:model,mode:'insensitive'}} : {}),
          ...(year ? {year:Number(year)} : {}),
        }} : {}),
      },
      include:{vehicle:true,seller:{select:{id:true,fullName:true}}},
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
    const parsed=createSchema.safeParse(await req.json());
    if(!parsed.success) return Response.json({ok:false,error:'INVALID_INPUT',details:parsed.error.flatten()},{status:400});
    const p=parsed.data;
    const vehicle=await db.vehicle.findUnique({where:{id:p.vehicleId},include:{violations:{where:{status:'PENDING'}},auctions:{where:{status:{in:['DRAFT','ACTIVE']}}}}});
    if(!vehicle) return Response.json({ok:false,error:'VEHICLE_NOT_FOUND'},{status:404});
    if(vehicle.ownerId!==user.id && !['ADMIN','SUPER_ADMIN','OWNER'].includes(user.role)) return Response.json({ok:false,error:'NOT_OWNER'},{status:403});
    if(vehicle.status!=='ACTIVE') return Response.json({ok:false,error:'VEHICLE_NOT_ACTIVE'},{status:409});
    if(['RESTRICTED','BLOCKED'].includes(vehicle.governmentStatus)) return Response.json({ok:false,error:'VEHICLE_RESTRICTED'},{status:409});
    if(vehicle.violations.length) return Response.json({ok:false,error:'VEHICLE_HAS_PENDING_VIOLATIONS'},{status:409});
    if(vehicle.auctions.length) return Response.json({ok:false,error:'VEHICLE_ALREADY_IN_AUCTION'},{status:409});
    if(new Date(p.endAt)<=new Date(p.startAt||Date.now())) return Response.json({ok:false,error:'INVALID_AUCTION_WINDOW'},{status:400});
    const auction=await db.$transaction(async tx=>{
      const locked=await tx.vehicle.updateMany({where:{id:vehicle.id,status:'ACTIVE',isReserved:false},data:{isReserved:true}});
      if(locked.count!==1) throw new Error('VEHICLE_ALREADY_RESERVED');
      return tx.auction.create({data:{
        vehicleId:p.vehicleId,sellerId:vehicle.ownerId,startingPrice:p.startingPrice,
        currentPrice:p.startingPrice,minimumIncrement:p.minimumIncrement, bidDepositAmount:p.bidDepositAmount ?? null,
        startAt:p.startAt?new Date(p.startAt):new Date(),endAt:new Date(p.endAt),status:'ACTIVE'
      },include:{vehicle:true}});
    });
    return Response.json({ok:true,auction},{status:201});
  } catch(e){return apiError(e);}
}
