export interface VehicleVerificationResult {
  exists: boolean;
  ownerId?: string;
  registrationStatus: string;
  restrictions: string[];
  inspectionStatus?: string;
  insuranceStatus?: string;
  message: string;
}

export interface VehicleProvider {
  name: string;
  verifyVehicle(plateNumber: string, vin: string): Promise<VehicleVerificationResult>;
  getOwnership(plateNumber: string): Promise<any>;
  getRestrictions(plateNumber: string): Promise<string[]>;
  getRegistrationStatus(plateNumber: string): Promise<string>;
}

export class MockVehicleVerificationProvider implements VehicleProvider {
  name = 'MOCK_VEHICLE';
  async verifyVehicle(plateNumber: string, vin: string): Promise<VehicleVerificationResult> {
    return {
      exists: true,
      registrationStatus: 'ACTIVE',
      restrictions: [],
      inspectionStatus: 'VALID',
      insuranceStatus: 'VALID',
      message: 'بيانات تجريبية — لا يوجد ربط رسمي مع المرور حاليًا.',
    };
  }
  async getOwnership(plateNumber: string) { return { owner: 'MOCK_OWNER', message: 'بيانات تجريبية' }; }
  async getRestrictions(plateNumber: string) { return []; }
  async getRegistrationStatus(plateNumber: string) { return 'ACTIVE'; }
}
