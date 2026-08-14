
// lib/rbac.ts - RBAC / ABAC - مركبات V11 - OWNER, SUPER_ADMIN, FINANCE_ADMIN, SUPPORT_ADMIN, AUDITOR

export type Role = 'USER' | 'SELLER' | 'BUYER' | 'DEALER' | 'SUPPORT' | 'FINANCE' | 'VERIFIER' | 'AUDITOR' | 'ADMIN' | 'SUPER_ADMIN' | 'OWNER' | 'MODERATOR' | 'FINANCE_ADMIN' | 'SUPPORT_ADMIN';

export type Permission = 
  | 'MANAGE_USERS'
  | 'MANAGE_VEHICLES'
  | 'MANAGE_SALES'
  | 'MANAGE_AUCTIONS'
  | 'MANAGE_ADVERTISEMENTS'
  | 'VIEW_FINANCIAL'
  | 'CONFIRM_PAYMENT'
  | 'MANAGE_EXCHANGE_RATE'
  | 'VIEW_AUDIT_LOGS'
  | 'EXPORT_FINANCIAL_REPORTS'
  | 'EXPORT_USER_DATA'
  | 'EXPORT_VEHICLE_DATA'
  | 'EXPORT_AUDIT_LOGS'
  | 'EXPORT_CASE_EVIDENCE'
  | 'REVIEW_IDENTITY'
  | 'MANAGE_FEATURE_FLAGS'
  | 'MANAGE_SERVICE_STATUS'
  | 'MANAGE_SECURITY_REVIEW'
  | 'VIEW_DISPUTES'
  | 'MANAGE_REFUND'
  | 'MANAGE_PAYOUT_RETRY'
  | 'VIEW_REPORTS'
  | 'MANAGE_BACKUP';

export interface RolePermissions {
  role: Role;
  permissions: Permission[];
}

export const ROLE_PERMISSIONS: Record<Role, Permission[]> = {
  OWNER: [
    'MANAGE_USERS', 'MANAGE_VEHICLES', 'MANAGE_SALES', 'MANAGE_AUCTIONS', 'MANAGE_ADVERTISEMENTS',
    'VIEW_FINANCIAL', 'CONFIRM_PAYMENT', 'MANAGE_EXCHANGE_RATE', 'VIEW_AUDIT_LOGS',
    'EXPORT_FINANCIAL_REPORTS', 'EXPORT_USER_DATA', 'EXPORT_VEHICLE_DATA', 'EXPORT_AUDIT_LOGS', 'EXPORT_CASE_EVIDENCE',
    'REVIEW_IDENTITY', 'MANAGE_FEATURE_FLAGS', 'MANAGE_SERVICE_STATUS', 'MANAGE_SECURITY_REVIEW',
    'VIEW_DISPUTES', 'MANAGE_REFUND', 'MANAGE_PAYOUT_RETRY', 'VIEW_REPORTS', 'MANAGE_BACKUP'
  ],
  SUPER_ADMIN: [
    'MANAGE_USERS', 'MANAGE_VEHICLES', 'MANAGE_SALES', 'MANAGE_AUCTIONS', 'MANAGE_ADVERTISEMENTS',
    'VIEW_FINANCIAL', 'CONFIRM_PAYMENT', 'MANAGE_EXCHANGE_RATE', 'VIEW_AUDIT_LOGS',
    'EXPORT_FINANCIAL_REPORTS', 'EXPORT_USER_DATA', 'EXPORT_VEHICLE_DATA', 'EXPORT_AUDIT_LOGS',
    'REVIEW_IDENTITY', 'MANAGE_FEATURE_FLAGS', 'MANAGE_SERVICE_STATUS', 'MANAGE_SECURITY_REVIEW',
    'VIEW_DISPUTES', 'MANAGE_REFUND', 'MANAGE_PAYOUT_RETRY', 'VIEW_REPORTS'
  ],
  FINANCE_ADMIN: [
    'VIEW_FINANCIAL', 'CONFIRM_PAYMENT', 'VIEW_AUDIT_LOGS', 'EXPORT_FINANCIAL_REPORTS',
    'MANAGE_REFUND', 'MANAGE_PAYOUT_RETRY', 'VIEW_REPORTS', 'VIEW_DISPUTES'
  ],
  SUPPORT_ADMIN: [
    'MANAGE_USERS', 'VIEW_AUDIT_LOGS', 'REVIEW_IDENTITY', 'VIEW_DISPUTES', 'VIEW_REPORTS'
  ],
  AUDITOR: [
    'VIEW_FINANCIAL', 'VIEW_AUDIT_LOGS', 'EXPORT_AUDIT_LOGS', 'EXPORT_FINANCIAL_REPORTS', 'VIEW_REPORTS', 'VIEW_DISPUTES'
  ],
  USER: [],
  SELLER: [],
  BUYER: [],
  DEALER: [],
  SUPPORT: [],
  FINANCE: ['VIEW_FINANCIAL', 'CONFIRM_PAYMENT', 'VIEW_AUDIT_LOGS', 'MANAGE_REFUND', 'MANAGE_PAYOUT_RETRY'],
  VERIFIER: ['REVIEW_IDENTITY', 'VIEW_AUDIT_LOGS'],
  ADMIN: ['MANAGE_USERS', 'MANAGE_VEHICLES', 'MANAGE_SALES', 'MANAGE_AUCTIONS', 'MANAGE_ADVERTISEMENTS', 'VIEW_FINANCIAL', 'CONFIRM_PAYMENT', 'VIEW_AUDIT_LOGS', 'REVIEW_IDENTITY', 'VIEW_DISPUTES', 'MANAGE_REFUND', 'MANAGE_PAYOUT_RETRY'],
  MODERATOR: ['MANAGE_ADVERTISEMENTS'],
};

export class RBACService {
  hasPermission(userRole: Role, permission: Permission): boolean {
    const permissions = ROLE_PERMISSIONS[userRole] || [];
    return permissions.includes(permission);
  }

  canAccessResource(userRole: Role, resource: string, action: string, condition?: unknown): boolean {
    void condition;
    // RBAC أساسي + ABAC مستقبلاً
    // WHO CAN DO WHAT ON WHICH RESOURCE UNDER WHICH CONDITION

    // مثال: OWNER يمكنه كل شيء
    if (userRole === 'OWNER') return true;

    // مثال: FINANCE_ADMIN لا يستطيع MANAGE_USERS
    if (resource === 'USER' && action === 'MANAGE' && userRole === 'FINANCE_ADMIN') {
      return false;
    }

    // مثال: AUDITOR لا يستطيع CONFIRM_PAYMENT
    if (action === 'CONFIRM_PAYMENT' && userRole === 'AUDITOR') {
      return false;
    }

    return this.hasPermission(userRole, `${action}_${resource}` as Permission) || 
           this.hasPermission(userRole, action as Permission);
  }

  requirePermission(userRole: Role, permission: Permission): void {
    if (!this.hasPermission(userRole, permission)) {
      throw new Error(`Access denied - Role ${userRole} does not have permission ${permission}`);
    }
  }

  getPermissionsForRole(role: Role): Permission[] {
    return ROLE_PERMISSIONS[role] || [];
  }
}

export const rbacService = new RBACService();
