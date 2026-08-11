import { getCurrentUser } from '@/lib/api-auth';
import { createOwnershipTransfer } from '@/lib/transfer-workflow';
import { db } from '@/lib/db';
import { z } from 'zod';
import { notificationService } from '@/lib/notifications';

const schema = z.object({
  vehicleId: z.string().min(1),
  buyerPhone: z.string().min(7),
  salePrice: z.number().positive(),
  authorizationId: z.string().optional(),
  listingType: z.enum(['DIRECT', 'MARKET', 'EXHIBITION', 'AUCTION']).default('MARKET'),
  soldThroughExhibitionService: z.boolean().default(false),
});

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
    await notificationService.sendNotification({ userId: buyer.id, type: 'TRANSFER_REQUEST', title: 'لديك طلب بيع مركبة', message: `لديك طلب شراء مركبة رقم العملية ${sale.id}`, priority: 'HIGH', channels: ['IN_APP'], operationId: sale.id });
    return Response.json({ ok: true, sale, buyer: { id: buyer.id, fullName: buyer.fullName, phoneMasked: `${buyer.phone.slice(0, 3)}***${buyer.phone.slice(-3)}` } }, { status: 201 });
  } catch (e) {
    const msg = e instanceof Error ? e.message : 'TRANSFER_CREATE_FAILED';
    return Response.json({ ok: false, error: msg }, { status: msg.startsWith('NOT_CONFIGURED') ? 503 : 400 });
  }
}
