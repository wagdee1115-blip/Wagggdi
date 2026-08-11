/** Identity Provider Interface - مركبات */
export interface IdentityVerificationInput {
  nationalId: string;
  dateOfBirth: string; // YYYY-MM-DD
  fullName?: string;
}
export interface IdentityVerificationResult {
  verified: boolean;
  status: 'PENDING' | 'VERIFIED' | 'FAILED' | 'REJECTED';
  providerReference?: string;
  message?: string;
}

export interface IdentityProvider {
  name: string;
  verifyIdentity(input: IdentityVerificationInput): Promise<IdentityVerificationResult>;
  getIdentityStatus(reference: string): Promise<IdentityVerificationResult>;
}

// Mock - لا يدعي أنه API حكومي
export class MockIdentityProvider implements IdentityProvider {
  name = 'MOCK_IDENTITY';
  async verifyIdentity(input: IdentityVerificationInput): Promise<IdentityVerificationResult> {
    // محاكاة: أي رقم هوية يبدأ بـ 1 يعتبر موثق للاختبار
    const isValid = input.nationalId.length >= 8;
    return {
      verified: isValid,
      status: isValid ? 'VERIFIED' : 'FAILED',
      providerReference: `MOCK-ID-${Date.now()}`,
      message: 'بيانات تجريبية — لا يوجد ربط رسمي حاليًا.',
    };
  }
  async getIdentityStatus(reference: string): Promise<IdentityVerificationResult> {
    return { verified: true, status: 'VERIFIED', providerReference: reference, message: 'بيانات تجريبية' };
  }
}
