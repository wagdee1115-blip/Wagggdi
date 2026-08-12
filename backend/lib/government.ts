// lib/government.ts - GovernmentIntegration - مركبات
// طبقة جاهزة للربط مع API حكومي رسمي - حاليا Mock Adapter

export type GovernmentProviderType = 'MOCK' | 'TRAFFIC_API' | 'FUTURE_GOV_API';

export interface GovernmentTransferRequest { operationId: string; vehicleId: string; plateNumber: string; vin: string; sellerId: string; sellerNationalId: string; buyerId: string; buyerNationalId: string; salePrice: number; saleDate: Date; }
export interface GovernmentTransferResponse { success: boolean; governmentReference?: string; status: 'PENDING' | 'APPROVED' | 'REJECTED' | 'FAILED'; message: string; electronicDocumentUrl?: string; documentData?: any; rejectionReason?: string; }

export interface GovernmentProvider {
  name: string;
  type: GovernmentProviderType;
  submitTransfer(request: GovernmentTransferRequest): Promise<GovernmentTransferResponse>;
  getTransferStatus(governmentReference: string): Promise<GovernmentTransferResponse>;
  getElectronicDocument(governmentReference: string): Promise<{ url?: string; data?: any }>;
}

export class UnconfiguredGovernmentProvider implements GovernmentProvider {
  name = 'TRAFFIC_NOT_CONFIGURED';
  type: GovernmentProviderType = 'TRAFFIC_API';
  async submitTransfer(): Promise<GovernmentTransferResponse> { throw new Error('NOT_CONFIGURED:TRAFFIC_PROVIDER_REQUIRED'); }
  async getTransferStatus(): Promise<GovernmentTransferResponse> { throw new Error('NOT_CONFIGURED:TRAFFIC_PROVIDER_REQUIRED'); }
  async getElectronicDocument(): Promise<{ url?: string; data?: any }> { throw new Error('NOT_CONFIGURED:TRAFFIC_PROVIDER_REQUIRED'); }
}

export class MockGovernmentProvider implements GovernmentProvider {
  name = 'MOCK_GOVERNMENT';
  type: GovernmentProviderType = 'MOCK';
  private transfers = new Map<string, GovernmentTransferResponse>();

  async submitTransfer(request: GovernmentTransferRequest): Promise<GovernmentTransferResponse> {
    const reference = `GOV-MOCK-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const response: GovernmentTransferResponse = { success: true, governmentReference: reference, status: 'PENDING', message: 'تم استلام طلب نقل الملكية - بيانات تجريبية - لا يوجد ربط رسمي حاليا' };
    this.transfers.set(reference, response);
    return response;
  }

  async getTransferStatus(governmentReference: string): Promise<GovernmentTransferResponse> {
    const existing = this.transfers.get(governmentReference);
    if (!existing) throw new Error('Government reference not found');
    return existing;
  }

  async getElectronicDocument(governmentReference: string): Promise<{ url?: string; data?: any }> {
    return { url: undefined, data: { message: 'الاستمارة الإلكترونية يتم الحصول عليها من نظام المرور الرسمي عبر التكامل - حاليا Mock', governmentReference, note: 'هذه ليست وثيقة حكومية حقيقية' } };
  }

  async mockApproveTransfer(governmentReference: string, approvedBy: string, role: string): Promise<GovernmentTransferResponse> {
    if (role !== 'OWNER' && role !== 'SUPER_ADMIN') throw new Error('Only OWNER/SUPER_ADMIN can mock approve government transfer in TEST/DEMO mode');
    const existing = this.transfers.get(governmentReference);
    if (!existing) throw new Error('Government reference not found');
    const approved: GovernmentTransferResponse = { ...existing, success: true, status: 'APPROVED', message: `تمت الموافقة على نقل الملكية - TEST/DEMO - بواسطة ${approvedBy}`, electronicDocumentUrl: `/api/government/documents/${governmentReference}`, documentData: { note: 'بيانات تجريبية - الاستمارة الحقيقية تأتي من المرور الرسمي' } };
    this.transfers.set(governmentReference, approved);
    return approved;
  }

  async mockRejectTransfer(governmentReference: string, reason: string, rejectedBy: string, role: string): Promise<GovernmentTransferResponse> {
    if (role !== 'OWNER' && role !== 'SUPER_ADMIN') throw new Error('Only OWNER/SUPER_ADMIN can mock reject');
    const existing = this.transfers.get(governmentReference);
    if (!existing) throw new Error('Not found');
    const rejected: GovernmentTransferResponse = { ...existing, success: false, status: 'REJECTED', message: `تم رفض نقل الملكية من المرور: ${reason}`, rejectionReason: reason };
    this.transfers.set(governmentReference, rejected);
    return rejected;
  }
}

export class FutureTrafficApiProvider implements GovernmentProvider {
  name = 'FUTURE_TRAFFIC_API';
  type: GovernmentProviderType = 'TRAFFIC_API';
  async submitTransfer(request: GovernmentTransferRequest): Promise<GovernmentTransferResponse> { throw new Error('Traffic API not configured yet - GovernmentIntegration ready for future official API.'); }
  async getTransferStatus(governmentReference: string): Promise<GovernmentTransferResponse> { throw new Error('Traffic API not configured'); }
  async getElectronicDocument(governmentReference: string): Promise<{ url?: string; data?: any }> { throw new Error('Traffic API not configured - Electronic document comes from official traffic system only'); }
}

export class GovernmentIntegration {
  private provider: GovernmentProvider;
  constructor(provider?: GovernmentProvider) { this.provider = provider ?? ((process.env.NODE_ENV === 'test' || process.env.NODE_ENV === 'development') ? new MockGovernmentProvider() : new UnconfiguredGovernmentProvider()); }

  async submitTransferIfEligible(params: { operationId: string; vehicleId: string; plateNumber: string; vin: string; sellerId: string; sellerNationalId: string; sellerVerified: boolean; buyerId: string; buyerNationalId: string; buyerVerified: boolean; buyerApproved: boolean; buyerOtpVerified: boolean; paymentVerified: boolean; fundsSecured: boolean; sellerOtpVerified: boolean; vehicleEligible: boolean; salePrice: number }): Promise<GovernmentTransferResponse> {
    const checks = [
      [params.sellerVerified, 'البائع غير موثق'], [params.buyerVerified, 'المشتري غير موثق'], [params.buyerApproved, 'المشتري لم يوافق'], [params.buyerOtpVerified, 'OTP المشتري غير صحيح'], [params.paymentVerified, 'الدفع غير مؤكد'], [params.fundsSecured, 'الأموال غير مؤمنة لدى Escrow'], [params.sellerOtpVerified, 'OTP البائع غير صحيح'], [params.vehicleEligible, 'المركبة غير مؤهلة للنقل'],
    ] as const;
    for (const [condition, message] of checks) if (!condition) throw new Error(`Government transfer eligibility failed: ${message}`);
    return this.provider.submitTransfer({ operationId: params.operationId, vehicleId: params.vehicleId, plateNumber: params.plateNumber, vin: params.vin, sellerId: params.sellerId, sellerNationalId: params.sellerNationalId, buyerId: params.buyerId, buyerNationalId: params.buyerNationalId, salePrice: params.salePrice, saleDate: new Date() });
  }

  async getStatus(governmentReference: string) { return this.provider.getTransferStatus(governmentReference); }
  async getElectronicDocument(governmentReference: string) { return this.provider.getElectronicDocument(governmentReference); }
  async mockApprove(governmentReference: string, approvedBy: string, role: string) { if (this.provider instanceof MockGovernmentProvider) return this.provider.mockApproveTransfer(governmentReference, approvedBy, role); throw new Error('Mock approve only available with Mock provider'); }
  setProvider(provider: GovernmentProvider) { this.provider = provider; }
}

export const governmentIntegration = new GovernmentIntegration();
