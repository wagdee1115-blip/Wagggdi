export interface PhoneProvider {
  name: string;
  configured: boolean;
  sendOtp(phone: string, otp: string, operationId: string): Promise<{
    providerReference: string;
    channel: 'SMS';
  }>;
  verifyOtp(phone: string, otp: string, reference: string): Promise<boolean>;
  verifyPhoneOwnership?(
    nationalId: string,
    phone: string,
  ): Promise<{ owned: boolean; message: string }>;
}

export class MockPhoneProvider implements PhoneProvider {
  name = 'MOCK_PHONE';
  configured = true;

  async sendOtp(phone: string, otp: string, operationId: string) {
    return {
      providerReference: `MOCK-SMS-${operationId}-${Date.now()}`,
      channel: 'SMS' as const,
    };
  }

  async verifyOtp(phone: string, otp: string, reference: string) {
    return /^\d{4}$/.test(otp) && Boolean(reference);
  }

  async verifyPhoneOwnership(nationalId: string, phone: string) {
    return {
      owned: Boolean(nationalId && phone),
      message: 'بيانات تجريبية — التحقق الحقيقي يتطلب مزودًا رسميًا.',
    };
  }
}

export class UnconfiguredPhoneProvider implements PhoneProvider {
  name = 'SMS_NOT_CONFIGURED';
  configured = false;

  async sendOtp(): Promise<{ providerReference: string; channel: 'SMS' }> {
    throw new Error('NOT_CONFIGURED:PHONE_PROVIDER_REQUIRED');
  }

  async verifyOtp(): Promise<boolean> {
    throw new Error('NOT_CONFIGURED:PHONE_PROVIDER_REQUIRED');
  }

  async verifyPhoneOwnership(): Promise<{ owned: boolean; message: string }> {
    throw new Error('NOT_CONFIGURED:PHONE_PROVIDER_REQUIRED');
  }
}

export const phoneProvider = new UnconfiguredPhoneProvider();
