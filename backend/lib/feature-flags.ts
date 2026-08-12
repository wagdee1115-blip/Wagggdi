
// lib/feature-flags.ts - Feature Flags - مركبات V11

export type FeatureFlagStatus = 'ENABLED' | 'DISABLED' | 'MAINTENANCE' | 'BETA';
export type FeatureFlagScope = 'INTERNAL_ONLY' | 'LIMITED' | 'PUBLIC';

export interface FeatureFlag {
  id: string;
  key: string;
  name: string;
  description?: string;
  status: FeatureFlagStatus;
  scope: FeatureFlagScope;
  enabledForRoles?: string[];
  enabledForUsers?: string[];
  createdBy: string;
  createdAt: Date;
  updatedAt: Date;
}

export class FeatureFlagService {
  private flags: Map<string, FeatureFlag> = new Map();

  constructor() {
    // إنشاء Feature Flags الافتراضية
    this.initializeDefaultFlags();
  }

  private initializeDefaultFlags() {
    const defaultFlags: Omit<FeatureFlag, 'id' | 'createdAt' | 'updatedAt'>[] = [
      { key: 'GOVERNMENT_INTEGRATION', name: 'التكامل الحكومي', description: 'تكامل المرور لنقل الملكية', status: 'DISABLED', scope: 'INTERNAL_ONLY', createdBy: 'SYSTEM' },
      { key: 'AI_VERIFICATION', name: 'التحقق بالذكاء الاصطناعي', status: 'BETA', scope: 'LIMITED', createdBy: 'SYSTEM' },
      { key: 'FACE_MATCH', name: 'مطابقة الوجه', status: 'BETA', scope: 'LIMITED', createdBy: 'SYSTEM' },
      { key: 'LIVENESS', name: 'كشف الحيوية', status: 'BETA', scope: 'LIMITED', createdBy: 'SYSTEM' },
      { key: 'PAYMENTS', name: 'المدفوعات', status: 'ENABLED', scope: 'PUBLIC', createdBy: 'SYSTEM' },
      { key: 'AUCTIONS', name: 'المزادات', status: 'ENABLED', scope: 'PUBLIC', createdBy: 'SYSTEM' },
      { key: 'VIOLATIONS', name: 'المخالفات', status: 'DISABLED', scope: 'INTERNAL_ONLY', createdBy: 'SYSTEM' },
      { key: 'RENEWALS', name: 'التجديد', status: 'DISABLED', scope: 'INTERNAL_ONLY', createdBy: 'SYSTEM' },
      { key: 'SMS', name: 'الرسائل النصية', status: 'ENABLED', scope: 'PUBLIC', createdBy: 'SYSTEM' },
      { key: 'BANK_EXCHANGE_RATE', name: 'سعر الصرف البنكي', status: 'DISABLED', scope: 'INTERNAL_ONLY', createdBy: 'SYSTEM' },
      { key: 'ELECTRONIC_REGISTRATION', name: 'الاستمارة الإلكترونية', status: 'DISABLED', scope: 'INTERNAL_ONLY', createdBy: 'SYSTEM' },
      { key: 'NEW_SALES', name: 'عمليات البيع الجديدة', status: 'ENABLED', scope: 'PUBLIC', createdBy: 'SYSTEM' },
    ];

    for (const flag of defaultFlags) {
      const fullFlag: FeatureFlag = {
        id: `FLAG-${flag.key}`,
        ...flag,
        createdAt: new Date(),
        updatedAt: new Date(),
      };
      this.flags.set(flag.key, fullFlag);
    }
  }

  isEnabled(key: string, userId?: string, userRole?: string): boolean {
    const flag = this.flags.get(key);
    if (!flag) return false;

    if (flag.status === 'DISABLED') return false;
    if (flag.status === 'MAINTENANCE') return false;

    if (flag.scope === 'INTERNAL_ONLY') {
      return userRole === 'OWNER' || userRole === 'SUPER_ADMIN';
    }

    if (flag.scope === 'LIMITED' && flag.enabledForRoles) {
      return flag.enabledForRoles.includes(userRole || '');
    }

    if (flag.status === 'ENABLED' || flag.status === 'BETA') {
      return true;
    }

    return false;
  }

  async updateFlag(key: string, updates: Partial<FeatureFlag>, updatedBy: string): Promise<FeatureFlag> {
    const flag = this.flags.get(key);
    if (!flag) throw new Error('Flag not found');

    Object.assign(flag, updates, { updatedAt: new Date() });
    this.flags.set(key, flag);

    console.log(`[FEATURE FLAG] Updated ${key} to ${flag.status} by ${updatedBy}`);

    return flag;
  }

  // Kill Switch - OWNER/SUPER_ADMIN يستطيع إيقاف ميزة معينة فقط
  async killSwitch(key: string, killedBy: string, reason: string): Promise<FeatureFlag> {
    return await this.updateFlag(key, { status: 'DISABLED' }, killedBy);
  }

  getFlag(key: string): FeatureFlag | undefined {
    return this.flags.get(key);
  }

  getAllFlags(): FeatureFlag[] {
    return Array.from(this.flags.values());
  }
}

export const featureFlagService = new FeatureFlagService();
