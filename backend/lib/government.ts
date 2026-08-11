
// lib/government.ts - GovernmentIntegration - مركبات
// طبقة جاهزة للربط مع API حكومي رسمي - حاليا Mock Adapter

export type GovernmentProviderType = 'MOCK' | 'TRAFFIC_API' | 'FUTURE_GOV_API';

export interface GovernmentTransferRequest {
  operationId: string;
  vehicleId: string;
  plateNumber: string;
  vin: string;
  sellerId: string;
  sellerNationalId: string;
  buyerId: string;
  buyerNationalId: string;
  salePrice: number;
  saleDate: Date;
}

export interface GovernmentTransferResponse {
  success: boolean;
  governmentReference?: string;
  status: 'PENDING' | 'APPROVED' | 'REJECTED' | 'FAILED';
  message: string;
  electronicDocumentUrl?: string; // رابط الاستمارة من المرور
  documentData?: any; // بيانات الاستمارة من المرور
  rejectionReason?: string;
}

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
  async getElectronicDocument(): Promise<{url?:string;data?:any}> { throw new Error('NOT_CONFIGURED:TRAFFIC_PROVIDER_REQUIRED'); }
}

export class MockGovernmentProvider implements GovernmentProvider {
  name = 'MOCK_GOVERNMENT';
  type: GovernmentProviderType = 'MOCK';
  private transfers: Map<string, GovernmentTransferResponse> = new Map();

  async submitTransfer(request: GovernmentTransferRequest): Promise<GovernmentTransferResponse> {
    // محاكاة - في الواقع يذهب لـ API المرور الرسمي
    const reference = `GOV-MOCK-${Date.now()}-${Math.random().toString(36).substr(2, 6)}`;
    
    const response: GovernmentTransferResponse = {
      success: true,
      governmentReference: reference,
      status: 'PENDING',
      message: 'تم استلام طلب نقل الملكية - في انتظار تأكيد المرور - بيانات تجريبية - لا يوجد ربط رسمي حاليا',
    };

    this.transfers.set(reference, response);
    
    console.log(`[MOCK GOV] Transfer submitted: ${reference} for vehicle ${request.plateNumber}`);
    
    return response;
  }

  async getTransferStatus(governmentReference: string): Promise<GovernmentTransferResponse> {
    const existing = this.transfers.get(governmentReference);
    if (!existing) {
      throw new Error('Government reference not found');
    }
    return existing;
  }

  async getElectronicDocument(governmentReference: string): Promise<{ url?: string; data?: any }> {
    // في الواقع: الحصول على الاستمارة من نظام المرور الرسمي
    // لا ننشئ وثيقة تدعي أنها حكومية
    return {
      url: undefined, // المرور يوفر الرابط
      data: {
        message: 'الاستمارة الإلكترونية يتم الحصول عليها من نظام المرور الرسمي عبر التكامل - حاليا Mock - لا ننشئ وثيقة مزيفة',
        governmentReference,
        note: 'في Production الحقيقي: يتم الحصول على الاستمارة/بياناتها من نظام المرور الرسمي عبر التكامل الرسمي',
      }
    };
  }

  // للاختبار فقط - محاكاة نجاح النقل - فقط OWNER/SUPER_ADMIN في TEST/DEMO
  async mockApproveTransfer(governmentReference: string, approvedBy: string, role: string): Promise<GovernmentTransferResponse> {
    if (role !== 'OWNER' && role !== 'SUPER_ADMIN') {
      throw new Error('Only OWNER/SUPER_ADMIN can mock approve government transfer in TEST/DEMO mode');
    }

    const existing = this.transfers.get(governmentReference);
    if (!existing) {
      throw new Error('Government reference not found');
    }

    const approved: GovernmentTransferResponse = {
      ...existing,
      success: true,
      status: 'APPROVED',
      message: `تمت الموافقة على نقل الملكية من المرور - بواسطة ${approvedBy} في وضع TEST/DEMO - محاكاة فقط`,
      electronicDocumentUrl: `/api/government/documents/${governmentReference}`,
      documentData: {
        plateNumber: 'Mock',
        newOwner: 'Mock Buyer',
        issueDate: new Date(),
        note: 'هذه بيانات تجريبية - الاستمارة الحقيقية تأتي من المرور الرسمي',
      }
    };

    this.transfers.set(governmentReference, approved);
    return approved;
  }

  // محاكاة رفض
  async mockRejectTransfer(governmentReference: string, reason: string, rejectedBy: string, role: string): Promise<GovernmentTransferResponse> {
    if (role !== 'OWNER' && role !== 'SUPER_ADMIN') {
      throw new Error('Only OWNER/SUPER_ADMIN can mock reject');
    }

    const existing = this.transfers.get(governmentReference);
    if (!existing) throw new Error('Not found');

    const rejected: GovernmentTransferResponse = {
      ...existing,
      success: false,
      status: 'REJECTED',
      message: `تم رفض نقل الملكية من المرور: ${reason}`,
      rejectionReason: reason,
    };

    this.transfers.set(governmentReference, rejected);
    return rejected;
  }
}

// مستقبلا: Traffic API الحقيقي
export class FutureTrafficApiProvider implements GovernmentProvider {
  name = 'FUTURE_TRAFFIC_API';
  type: GovernmentProviderType = 'TRAFFIC_API';

  async submitTransfer(request: GovernmentTransferRequest): Promise<GovernmentTransferResponse> {
    // جاهز للربط مع API المرور الرسمي عند توفره
    throw new Error('Traffic API not configured yet - GovernmentIntegration ready for future official API. No mock is real system in production.');
  }

  async getTransferStatus(governmentReference: string): Promise<GovernmentTransferResponse> {
    throw new Error('Traffic API not configured');
  }

  async getElectronicDocument(governmentReference: string) {
    throw new Error('Traffic API not configured - Electronic document comes from official traffic system only');
  }
}

export class GovernmentIntegration {
  private provider: GovernmentProvider;

  constructor(provider?: GovernmentProvider) {
    this.provider = provider || ((process.env.NODE_ENV === 'test' || process.env.NODE_ENV === 'development') ? new MockGovernmentProvider() : new UnconfiguredGovernmentProvider());
  }

  // إرسال طلب نقل الملكية - بعد استيفاء جميع الشروط
  async submitTransferIfEligible(params: {
    operationId: string;
    vehicleId: string;
    plateNumber: string;
    vin: string;
    sellerId: string;
    sellerNationalId: string;
    sellerVerified: boolean;
    buyerId: string;
    buyerNationalId: string;
    buyerVerified: boolean;
    buyerApproved: boolean;
    buyerOtpVerified: boolean;
    paymentVerified: boolean;
    fundsSecured: boolean;
    sellerOtpVerified: boolean;
    vehicleEligible: boolean;
    salePrice: number;
  }): Promise<GovernmentTransferResponse> {
    // التحقق من جميع الشروط
    const checks = [
      { condition: params.sellerVerified, message: 'البائع غير موثق' },
      { condition: params.buyerVerified, message: 'المشتري غير موثق' },
      { condition: params.buyerApproved, message: 'المشتري لم يوافق' },
      { condition: params.buyerOtpVerified, message: 'OTP المشتري غير صحيح' },
      { condition: params.paymentVerified, message: 'الدفع غير مؤكد' },
      { condition: params.fundsSecured, message: 'الأموال غير مؤمنة لدى Escrow' },
      { condition: params.sellerOtpVerified, message: 'OTP البائع غير صحيح' },
      { condition: params.vehicleEligible, message: 'المركبة غير مؤهلة للنقل' },
    ];

    for (const check of checks) {
      if (!check.condition) {
        throw new Error(`Government transfer eligibility failed: ${check.message}`);
      }
    }

    const request: GovernmentTransferRequest = {
      operationId: params.operationId,
      vehicleId: params.vehicleId,
      plateNumber: params.plateNumber,
      vin: params.vin,
      sellerId: params.sellerId,
      sellerNationalId: params.sellerNationalId,
      buyerId: params.buyerId,
      buyerNationalId: params.buyerNationalId,
      salePrice: params.salePrice,
      saleDate: new Date(),
    };

    return await this.provider.submitTransfer(request);
  }

  async getStatus(governmentReference: string) {
    return await this.provider.getTransferStatus(governmentReference);
  }

  async getElectronicDocument(governmentReference: string) {
    return await this.provider.getElectronicDocument(governmentReference);
  }

  // للاختبار فقط
  async mockApprove(governmentReference: string, approvedBy: string, role: string) {
    if (this.provider instanceof MockGovernmentProvider) {
      return await this.provider.mockApproveTransfer(governmentReference, approvedBy, role);
    }
    throw new Error('Mock approve only available with Mock provider');
  }

  setProvider(provider: GovernmentProvider) {
    this.provider = provider;
  }
}

export const governmentIntegration = new GovernmentIntegration();
