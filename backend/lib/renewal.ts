
// lib/renewal.ts - نظام تجديد الاستمارة - مركبات V11

export type RenewalStatus = 'ELIGIBLE' | 'NOT_ELIGIBLE' | 'PENDING_PAYMENT' | 'PENDING_GOVERNMENT' | 'COMPLETED' | 'FAILED';

export interface RenewalRequest {
  id: string;
  vehicleId: string;
  plateNumber: string;
  ownerId: string;
  currentExpiryDate: Date;
  newExpiryDate?: Date;
  feesYER: number;
  status: RenewalStatus;
  governmentReference?: string;
  paymentReference?: string;
  completedAt?: Date;
  createdAt: Date;
  updatedAt: Date;
}

export interface RenewalProvider {
  name: string;
  checkEligibility(vehicleId: string, plateNumber: string): Promise<{ eligible: boolean; reason?: string; feesYER: number }>;
  submitRenewal(request: RenewalRequest): Promise<{ governmentReference: string; status: RenewalStatus }>;
  getRenewalStatus(governmentReference: string): Promise<RenewalStatus>;
}

export class MockRenewalProvider implements RenewalProvider {
  name = 'MOCK_RENEWAL';

  async checkEligibility(vehicleId: string, plateNumber: string) {
    console.log(`[MOCK RENEWAL] Check eligibility for ${plateNumber} - لا يوجد ربط رسمي`);

    return {
      eligible: true,
      feesYER: 10000, // رسوم تجريبية
    };
  }

  async submitRenewal(request: RenewalRequest) {
    console.log(`[MOCK RENEWAL] Submit renewal for ${request.plateNumber} - بيانات تجريبية`);

    return {
      governmentReference: `GOV-RENEWAL-${Date.now()}`,
      status: 'PENDING_GOVERNMENT' as RenewalStatus,
    };
  }

  async getRenewalStatus(governmentReference: string): Promise<RenewalStatus> {
    return 'COMPLETED';
  }
}

export class UnconfiguredRenewalProvider implements RenewalProvider {
  name='RENEWAL_NOT_CONFIGURED';
  async checkEligibility(_vehicleId:string,_plateNumber:string):Promise<{eligible:boolean;reason?:string;feesYER:number}>{throw new Error('NOT_CONFIGURED:TRAFFIC_PROVIDER_REQUIRED');}
  async submitRenewal(_request:RenewalRequest):Promise<{governmentReference:string;status:RenewalStatus}>{throw new Error('NOT_CONFIGURED:TRAFFIC_PROVIDER_REQUIRED');}
  async getRenewalStatus(_governmentReference:string):Promise<RenewalStatus>{throw new Error('NOT_CONFIGURED:TRAFFIC_PROVIDER_REQUIRED');}
}

export class RenewalService {
  private requests: Map<string, RenewalRequest> = new Map();
  private provider: RenewalProvider;

  constructor(provider?: RenewalProvider) {
    this.provider = provider || ((process.env.NODE_ENV === 'test' || process.env.NODE_ENV === 'development') ? new MockRenewalProvider() : new UnconfiguredRenewalProvider());
  }

  async checkEligibility(vehicleId: string, plateNumber: string): Promise<{ eligible: boolean; feesYER: number; reason?: string }> {
    return await this.provider.checkEligibility(vehicleId, plateNumber);
  }

  async createRenewalRequest(params: {
    vehicleId: string;
    plateNumber: string;
    ownerId: string;
    currentExpiryDate: Date;
  }): Promise<RenewalRequest> {
    const eligibility = await this.checkEligibility(params.vehicleId, params.plateNumber);

    if (!eligibility.eligible) {
      throw new Error(`Renewal not eligible: ${eligibility.reason}`);
    }

    const request: RenewalRequest = {
      id: `RENEWAL-${Date.now()}-${Math.random().toString(36).substr(2, 6)}`,
      vehicleId: params.vehicleId,
      plateNumber: params.plateNumber,
      ownerId: params.ownerId,
      currentExpiryDate: params.currentExpiryDate,
      feesYER: eligibility.feesYER,
      status: 'ELIGIBLE',
      createdAt: new Date(),
      updatedAt: new Date(),
    };

    this.requests.set(request.id, request);

    return request;
  }

  async submitRenewal(requestId: string): Promise<RenewalRequest> {
    const request = this.requests.get(requestId);
    if (!request) throw new Error('Renewal request not found');

    if (request.status !== 'ELIGIBLE') {
      throw new Error('Renewal not eligible');
    }

    const result = await this.provider.submitRenewal(request);

    request.governmentReference = result.governmentReference;
    request.status = result.status;
    request.updatedAt = new Date();

    this.requests.set(requestId, request);

    return request;
  }

  getRequest(id: string): RenewalRequest | undefined {
    return this.requests.get(id);
  }
}

export const renewalService = new RenewalService();
