export interface PaymentProvider {
  name: string;
  createPayment(amount: number, currency: string, meta?: any): Promise<{ providerReference: string; status: string }>;
  holdPayment(reference: string): Promise<{ status: string }>;
  releasePayment(reference: string): Promise<{ status: string }>;
  refundPayment(reference: string): Promise<{ status: string }>;
  getPaymentStatus(reference: string): Promise<{ status: string }>;
}

export class MockPaymentProvider implements PaymentProvider {
  name = 'MOCK_PAYMENT';
  async createPayment(amount: number, currency: string) {
    return { providerReference: `MOCK-PAY-${Date.now()}`, status: 'CREATED' };
  }
  async holdPayment(ref: string) { return { status: 'HELD' }; }
  async releasePayment(ref: string) { return { status: 'SUCCESS' }; }
  async refundPayment(ref: string) { return { status: 'REFUNDED' }; }
  async getPaymentStatus(ref: string) { return { status: 'HELD' }; }
}
