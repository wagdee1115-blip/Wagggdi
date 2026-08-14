import { apiError, getCurrentUser } from '@/lib/api-auth';
import { createOwnershipTransfer } from '@/lib/transfer-workflow';
import { db } from '@/lib/db';
import { z } from 'zod';

const schema = z.object({
  vehicleId: z.string().min(1),
  buyerPhone: z.string().min(7),
  salePrice: z.number().positive(),
  authorizationId: z.string().optional(),
  listingType: z.enum(['DIRECT', 'MARKET', 'EXHIBITION', 'AUCTION']).default('MARKET'),
  soldThroughExhibitionService: z.boolean().default(false),
});

export async function GET() {
  try {
    const u = await getCurrentUser();
    if (!u) return Response.json({ ok: false, error: 'UNAUTHORIZED' }, { status: 401 });
    const sales = await db.vehicleSale.findMany({
      where: {
        OR: [
          { sellerId: u.id },
          { buyerId: u.id },
          { payoutUserId: u.id },
        ],
      },
      orderBy: { createdAt: 'desc' },
      take: 50,
      select: {
        id: true,
        status: true,
        sellerId: true,
        sellerName: true,
        buyerId: true,
        buyerName: true,
        payoutUserId: true,
        vehicleAmountYER: true,
        platformFeeUSD: true,
        platformFeeYER: true,
        transferFeeUSD: true,
        transferFeeYER: true,
        totalPaidYER: true,
        exchangeRate: true,
        buyerOtpVerified: true,
        sellerOtpVerified: true,
        expiresAt: true,
        createdAt: true,
        vehicle: {
          select: { id: true, plateNumber: true, make: true, model: true, year: true, city: true },
        },
      },
    });
    const safeSales = sales.map(({ sellerId, buyerId, payoutUserId, ...sale }) => ({
      ...sale,
      party: buyerId === u.id ? 'BUYER' : sellerId === u.id ? 'SELLER' : payoutUserId === u.id ? 'PAYOUT_OWNER' : 'STAFF',
    }));
    return Response.json({ ok: true, sales: safeSales }, { headers: { 'Cache-Control': 'private, no-store' } });
  } catch (e) {
    return apiError(e);
  }
}

export async function POST(req: Request) {
  try {
    const u = await getCurrentUser();
    if (!u || u.status !== 'ACTIVE') return Response.json({ ok: false, error: 'UNAUTHORIZED' }, { status: 401 });
    const p = schema.safeParse(await req.json());
    if (!p.success) return Response.json({ ok: false, error: 'INVALID_INPUT', details: p.error.flatten() }, { status: 400 });
    const buyer = await db.user.findUnique({ where: { phone: p.data.buyerPhone } });
    if (!buyer) return Response.json({ ok: false, error: 'BUYER_NOT_FOUND' }, { status: 404 });
    if (buyer.id === u.id) return Response.json({ ok: false, error: 'SELLER_AND_BUYER_MUST_DIFFER' }, { status: 409 });

    const sale = await createOwnershipTransfer({
      vehicleId: p.data.vehicleId,
      buyerId: buyer.id,
      sellerId: u.id,
      salePrice: p.data.salePrice,
      listingType: p.data.listingType,
      soldThroughExhibitionService: p.data.soldThroughExhibitionService,
      auctionId: undefined,
    });
    return Response.json({ ok: true, sale: { id: sale.id, status: sale.status, expiresAt: sale.expiresAt }, nextAction: 'SELLER_OTP_REQUIRED', buyer: { fullName: buyer.fullName, phoneMasked: `${buyer.phone.slice(0, 3)}***${buyer.phone.slice(-3)}` } }, { status: 201 });
  } catch (e) {
    return apiError(e);
  }
}
