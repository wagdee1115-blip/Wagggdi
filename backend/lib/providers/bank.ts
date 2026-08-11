export interface BankProvider {
  name: string;
  verifyAccount(accountIdentifier: string, holderName: string): Promise<{ valid: boolean; holderMatch: boolean; reference: string; message: string }>;
}

export class MockBankProvider implements BankProvider {
  name = 'MOCK_BANK';
  async verifyAccount(accountIdentifier: string, holderName: string) {
    return {
      valid: true,
      holderMatch: true,
      reference: `MOCK-BANK-${Date.now()}`,
      message: 'بيانات تجريبية — التحقق الحقيقي يتطلب ربط بنكي رسمي.',
    };
  }
}
