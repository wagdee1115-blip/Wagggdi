// Central provider registry. Real production must never silently fall back to mocks.
import { MockIdentityProvider } from './identity';
import { MockPhoneProvider } from './phone';
import { MockVehicleVerificationProvider } from './vehicle';
import { MockPaymentProvider } from './payment';
import { MockBankProvider } from './bank';

const isTestLike = process.env.NODE_ENV === 'test' || process.env.NODE_ENV === 'development';

const testProviders = {
  identity: new MockIdentityProvider(),
  phone: new MockPhoneProvider(),
  vehicle: new MockVehicleVerificationProvider(),
  payment: new MockPaymentProvider(),
  bank: new MockBankProvider(),
};

const productionProviders = new Proxy({} as typeof testProviders, {
  get(_target, property: string) {
    return {
      name: `${property.toUpperCase()}_NOT_CONFIGURED`,
      configured: false,
      async createPayment() { throw new Error(`NOT_CONFIGURED:${property.toUpperCase()}_PROVIDER_REQUIRED`); },
      async holdPayment() { throw new Error(`NOT_CONFIGURED:${property.toUpperCase()}_PROVIDER_REQUIRED`); },
      async releasePayment() { throw new Error(`NOT_CONFIGURED:${property.toUpperCase()}_PROVIDER_REQUIRED`); },
      async refundPayment() { throw new Error(`NOT_CONFIGURED:${property.toUpperCase()}_PROVIDER_REQUIRED`); },
      async getPaymentStatus() { throw new Error(`NOT_CONFIGURED:${property.toUpperCase()}_PROVIDER_REQUIRED`); },
      async verifyIdentity() { throw new Error(`NOT_CONFIGURED:${property.toUpperCase()}_PROVIDER_REQUIRED`); },
      async getIdentityStatus() { throw new Error(`NOT_CONFIGURED:${property.toUpperCase()}_PROVIDER_REQUIRED`); },
      async sendOtp() { throw new Error(`NOT_CONFIGURED:${property.toUpperCase()}_PROVIDER_REQUIRED`); },
      async verifyOtp() { throw new Error(`NOT_CONFIGURED:${property.toUpperCase()}_PROVIDER_REQUIRED`); },
      async verifyAccount() { throw new Error(`NOT_CONFIGURED:${property.toUpperCase()}_PROVIDER_REQUIRED`); },
      async verifyVehicle() { throw new Error(`NOT_CONFIGURED:${property.toUpperCase()}_PROVIDER_REQUIRED`); },
    };
  },
});

export const providers = isTestLike ? testProviders : productionProviders;

export const integrationStatuses = [
  { providerName: 'IDENTITY', providerType: 'IDENTITY', status: 'NOT_CONFIGURED' },
  { providerName: 'PHONE', providerType: 'PHONE', status: 'NOT_CONFIGURED' },
  { providerName: 'VEHICLE', providerType: 'VEHICLE', status: 'NOT_CONFIGURED' },
  { providerName: 'INSURANCE', providerType: 'INSURANCE', status: 'NOT_CONFIGURED' },
  { providerName: 'INSPECTION', providerType: 'INSPECTION', status: 'NOT_CONFIGURED' },
  { providerName: 'VIOLATION', providerType: 'VIOLATION', status: 'NOT_CONFIGURED' },
  { providerName: 'APPOINTMENT', providerType: 'APPOINTMENT', status: 'NOT_CONFIGURED' },
  { providerName: 'BANK', providerType: 'BANK', status: 'NOT_CONFIGURED' },
  { providerName: 'PAYMENT', providerType: 'PAYMENT', status: 'NOT_CONFIGURED' },
  { providerName: 'STORAGE', providerType: 'STORAGE', status: 'NOT_CONFIGURED' },
  { providerName: 'MALWARE_SCANNER', providerType: 'MALWARE_SCANNER', status: 'NOT_CONFIGURED' },
] as const;
