
// lib/violations.ts - نظام المخالفات - مركبات V11

export type ViolationStatus = 'PENDING' | 'PAID' | 'DISPUTED' | 'CANCELLED';
export type ViolationType = 'SPEEDING' | 'PARKING' | 'SIGNAL' | 'LICENSE' | 'OTHER';

export interface Violation {
  id: string;
  vehicleId: string;
  plateNumber: string;
  type: ViolationType;
  description: string;
  amountYER: number;
  location?: string;
  violationDate: Date;
  dueDate: Date;
  status: ViolationStatus;
  governmentReference?: string;
  paidAt?: Date;
  receiptUrl?: string;
  createdAt: Date;
}

export interface ViolationProvider {
  name: string;
  inquiryViolations(plateNumber: string): Promise<Violation[]>;
  payViolation(violationId: string, amountYER: number): Promise<{ paid: boolean; receiptUrl: string; governmentReference: string }>;
}

export class MockViolationProvider implements ViolationProvider {
  name = 'MOCK_VIOLATION';
  private violations: Map<string, Violation[]> = new Map();

  async inquiryViolations(plateNumber: string): Promise<Violation[]> {
    console.log(`[MOCK VIOLATION] Inquiry for plate ${plateNumber} - لا يوجد ربط رسمي حاليا`);

    // محاكاة - لا يوجد مخالفات
    return this.violations.get(plateNumber) || [];
  }

  async payViolation(violationId: string, amountYER: number) {
    console.log(`[MOCK VIOLATION] Pay violation ${violationId} - ${amountYER} YER - بيانات تجريبية`);

    return {
      paid: true,
      receiptUrl: `/receipts/violation-${violationId}`,
      governmentReference: `GOV-VIOLATION-${Date.now()}`,
    };
  }

  // للاختبار فقط - إضافة مخالفة وهمية
  addMockViolation(plateNumber: string, violation: Partial<Violation>): Violation {
    const v: Violation = {
      id: `VIOLATION-${Date.now()}`,
      vehicleId: violation.vehicleId || 'MOCK-VEHICLE',
      plateNumber,
      type: violation.type || 'SPEEDING',
      description: violation.description || 'مخالفة سرعة - بيانات تجريبية',
      amountYER: violation.amountYER || 5000,
      violationDate: new Date(),
      dueDate: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000),
      status: 'PENDING',
      createdAt: new Date(),
    };

    const list = this.violations.get(plateNumber) || [];
    list.push(v);
    this.violations.set(plateNumber, list);

    return v;
  }
}

export class UnconfiguredViolationProvider implements ViolationProvider {
  name='VIOLATION_NOT_CONFIGURED';
  async inquiryViolations(_plateNumber: string): Promise<Violation[]> { throw new Error('NOT_CONFIGURED:TRAFFIC_PROVIDER_REQUIRED'); }
  async payViolation(_violationId: string, _amountYER: number): Promise<{ paid: boolean; receiptUrl: string; governmentReference: string }> { throw new Error('NOT_CONFIGURED:TRAFFIC_PROVIDER_REQUIRED'); }
}

export class ViolationService {
  private provider: ViolationProvider;

  constructor(provider?: ViolationProvider) {
    this.provider = provider || ((process.env.NODE_ENV === 'test' || process.env.NODE_ENV === 'development') ? new MockViolationProvider() : new UnconfiguredViolationProvider());
  }

  async inquiry(plateNumber: string): Promise<Violation[]> {
    return await this.provider.inquiryViolations(plateNumber);
  }

  async pay(violationId: string, amountYER: number): Promise<{ paid: boolean; violation: Violation }> {
    const result = await this.provider.payViolation(violationId, amountYER);

    if (!result.paid) {
      throw new Error('Violation payment failed - No confirmation from government source');
    }

    // في الإنتاج: تحديث حالة المخالفة بعد تأكيد رسمي
    // لا يتم الادعاء بأن المخالفة مدفوعة بدون Confirmation من المصدر المعتمد

    return {
      paid: result.paid,
      violation: {
        id: violationId,
        vehicleId: 'UNKNOWN',
        plateNumber: 'UNKNOWN',
        type: 'OTHER',
        description: 'Paid',
        amountYER,
        violationDate: new Date(),
        dueDate: new Date(),
        status: 'PAID',
        governmentReference: result.governmentReference,
        paidAt: new Date(),
        receiptUrl: result.receiptUrl,
        createdAt: new Date(),
      },
    };
  }
}

export const violationService = new ViolationService();
