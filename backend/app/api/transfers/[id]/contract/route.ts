import { getCurrentUser, getSensitiveUser } from '@/lib/api-auth';
import { db } from '@/lib/db';
import { contractPdfService, type ContractData } from '@/lib/contract-pdf';
import { contractPayloadHash, type StoredContractEnvelope } from '@/lib/contract-pdf-v2';

type SerializedContract = {
  contractNumber: string;
  operationId: string;
  createdAt: string;
  seller: ContractData['seller'];
  buyer: ContractData['buyer'];
  vehicle: ContractData['vehicle'];
  financial: ContractData['financial'];
  transfer: Omit<ContractData['transfer'], 'transferDate'> & { transferDate: string };
  approvals: { buyerApprovedAt?: string | null; buyerOtpVerifiedAt?: string | null; sellerApprovedAt?: string | null; sellerOtpVerifiedAt?: string | null; paymentVerifiedAt?: string | null };
};

function escapeHtml(value: string) {
  return value.replace(/[&<>'"]/g, character => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;' })[character]!);
}

function date(value?: string | null) { return value ? new Date(value) : undefined; }

export async function GET(_: Request, { params }: { params: Promise<{ id: string }> }) {
  const user = await getCurrentUser();
  if (!user) return Response.json({ ok: false, error: 'UNAUTHORIZED' }, { status: 401 });
  const sale = await db.vehicleSale.findUnique({ where: { id: (await params).id }, select: { id: true, sellerId: true, buyerId: true, payoutUserId: true, contract: true } });
  if (!sale) return Response.json({ ok: false, error: 'SALE_NOT_FOUND' }, { status: 404 });
  const participant = [sale.sellerId, sale.buyerId, sale.payoutUserId].includes(user.id);
  if (!participant) {
    const sensitiveUser = await getSensitiveUser();
    if (!sensitiveUser || sensitiveUser.id !== user.id || !['SUPER_ADMIN', 'OWNER'].includes(sensitiveUser.role)) {
      return Response.json({ ok: false, error: 'FORBIDDEN' }, { status: 403 });
    }
  }
  if (!sale.contract) return Response.json({ ok: false, error: 'CONTRACT_NOT_ISSUED' }, { status: 404 });
  const envelope = sale.contract.contractData as unknown as StoredContractEnvelope;
  if (envelope.version !== 1 || !envelope.payload || !envelope.integrity?.sha256) return Response.json({ ok: false, error: 'CONTRACT_FORMAT_INVALID' }, { status: 409 });
  const calculated = contractPayloadHash(envelope.payload);
  if (calculated !== envelope.integrity.sha256) return Response.json({ ok: false, error: 'CONTRACT_INTEGRITY_FAILED' }, { status: 409 });
  const raw = envelope.payload as unknown as SerializedContract;
  const contract: ContractData = {
    contractNumber: escapeHtml(raw.contractNumber), operationId: escapeHtml(raw.operationId), createdAt: new Date(raw.createdAt),
    seller: { ...raw.seller, name: escapeHtml(raw.seller.name), nationalId: escapeHtml(raw.seller.nationalId), phone: escapeHtml(raw.seller.phone), verificationStatus: escapeHtml(raw.seller.verificationStatus) },
    buyer: { ...raw.buyer, name: escapeHtml(raw.buyer.name), nationalId: escapeHtml(raw.buyer.nationalId), phone: escapeHtml(raw.buyer.phone), verificationStatus: escapeHtml(raw.buyer.verificationStatus) },
    vehicle: { ...raw.vehicle, plateNumber: escapeHtml(raw.vehicle.plateNumber), vin: raw.vehicle.vin ? escapeHtml(raw.vehicle.vin) : undefined, make: escapeHtml(raw.vehicle.make), model: escapeHtml(raw.vehicle.model), color: escapeHtml(raw.vehicle.color) },
    financial: { ...raw.financial, paymentMethod: escapeHtml(raw.financial.paymentMethod), paymentStatus: escapeHtml(raw.financial.paymentStatus) },
    transfer: { ...raw.transfer, status: escapeHtml(raw.transfer.status), governmentReference: raw.transfer.governmentReference ? escapeHtml(raw.transfer.governmentReference) : undefined, electronicDocumentUrl: undefined, transferDate: new Date(raw.transfer.transferDate) },
    approvals: { buyerApprovedAt: date(raw.approvals.buyerApprovedAt), buyerOtpVerifiedAt: date(raw.approvals.buyerOtpVerifiedAt), sellerApprovedAt: date(raw.approvals.sellerApprovedAt), sellerOtpVerifiedAt: date(raw.approvals.sellerOtpVerifiedAt), paymentVerifiedAt: date(raw.approvals.paymentVerifiedAt) },
  };
  const html = contractPdfService.generateContractHtml(contract);
  return new Response(html, { headers: {
    'Content-Type': 'text/html; charset=utf-8',
    'Content-Disposition': `inline; filename="${sale.contract.contractNumber.replace(/[^A-Za-z0-9_-]/g, '_')}.html"`,
    'Cache-Control': 'private, no-store',
    'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'; img-src data:; base-uri 'none'; form-action 'none'",
    'X-Content-Type-Options': 'nosniff',
    'X-Contract-SHA256': envelope.integrity.sha256,
  } });
}
