
// lib/audit-log.ts - Audit Log - APPEND ONLY - مركبات V11

export type AuditAction = 
  | 'LOGIN' | 'LOGOUT' | 'OTP_REQUESTED' | 'OTP_VERIFIED' | 'OTP_FAILED' | 'OTP_EXPIRED' | 'OTP_BLOCKED'
  | 'IDENTITY_SUBMITTED' | 'IDENTITY_VERIFIED' | 'IDENTITY_REJECTED'
  | 'VEHICLE_CREATED' | 'VEHICLE_UPDATED' | 'VEHICLE_LOCKED' | 'VEHICLE_UNLOCKED'
  | 'SALE_CREATED' | 'BUYER_IDENTIFIED' | 'BUYER_APPROVED' | 'BUYER_REJECTED'
  | 'PAYMENT_CREATED' | 'PAYMENT_CONFIRMED' | 'PAYMENT_FAILED' | 'PAYMENT_EXPIRED'
  | 'ESCROW_HELD' | 'ESCROW_SECURED' | 'ESCROW_RELEASED'
  | 'TRANSFER_STARTED' | 'TRANSFER_CONFIRMED' | 'TRANSFER_FAILED'
  | 'CONTRACT_GENERATED' | 'CONTRACT_VERIFIED'
  | 'PAYOUT_PROTECTION_STARTED' | 'PAYOUT_PENDING' | 'PAYOUT_PROCESSING' | 'PAYOUT_CONFIRMED' | 'PAYOUT_FAILED'
  | 'REFUND_PENDING' | 'REFUND_PROCESSING' | 'REFUNDED' | 'REFUND_FAILED'
  | 'AUCTION_CREATED' | 'BID_PLACED' | 'AUCTION_ENDED'
  | 'ADVERTISEMENT_CREATED' | 'ADVERTISEMENT_ACTIVATED' | 'ADVERTISEMENT_PAUSED'
  | 'EXCHANGE_RATE_CHANGED' | 'FEATURE_FLAG_CHANGED' | 'SERVICE_STATUS_CHANGED'
  | 'ADMIN_ACTION' | 'SECURITY_REVIEW' | 'DISPUTE_CREATED'
  | 'EXPORT_FINANCIAL_REPORT' | 'EXPORT_USER_DATA' | 'EXPORT_AUDIT_LOGS';

export interface AuditLogEntry {
  id: string;
  userId?: string;
  userName?: string;
  userRole?: string;
  action: AuditAction;
  resourceType?: string;
  resourceId?: string;
  operationId?: string;
  requestId: string;
  oldValue?: any;
  newValue?: any;
  ipAddress?: string;
  userAgent?: string;
  timestamp: Date;
  metadata?: any;
  // لا نحفظ: Passwords, Tokens, OTP, Secrets
}

export interface CorrectionEvent {
  id: string;
  originalEventId: string;
  correctedBy: string;
  correctionReason: string;
  oldValue: any;
  newValue: any;
  createdAt: Date;
}

export class AuditLogService {
  private logs: AuditLogEntry[] = [];
  private corrections: CorrectionEvent[] = [];

  async log(entry: Omit<AuditLogEntry, 'id' | 'timestamp' | 'requestId'> & { requestId?: string }): Promise<AuditLogEntry> {
    // تنظيف البيانات الحساسة - لا تسجل Secrets
    const sanitizedOldValue = this.sanitize(entry.oldValue);
    const sanitizedNewValue = this.sanitize(entry.newValue);
    const sanitizedMetadata = this.sanitize(entry.metadata);

    const logEntry: AuditLogEntry = {
      id: `AUDIT-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`,
      ...entry,
      oldValue: sanitizedOldValue,
      newValue: sanitizedNewValue,
      metadata: sanitizedMetadata,
      requestId: entry.requestId || `REQ-${Date.now()}-${Math.random().toString(36).substr(2, 6)}`,
      timestamp: new Date(),
    };

    // APPEND ONLY - لا تعديل
    this.logs.push(logEntry);

    console.log(`[AUDIT] ${logEntry.action} - User: ${logEntry.userId} - Resource: ${logEntry.resourceId} - Op: ${logEntry.operationId}`);

    return logEntry;
  }

  private sanitize(data: any): any {
    if (!data) return data;

    const sensitiveFields = ['password', 'token', 'otp', 'secret', 'apiKey', 'apiSecret', 'privateKey', 'creditCard', 'cvv'];
    
    if (typeof data === 'object') {
      const sanitized = { ...data };
      for (const field of sensitiveFields) {
        if (field in sanitized) {
          sanitized[field] = '***REDACTED***';
        }
        // تحقق case insensitive
        for (const key of Object.keys(sanitized)) {
          if (key.toLowerCase().includes(field.toLowerCase())) {
            sanitized[key] = '***REDACTED***';
          }
        }
      }
      return sanitized;
    }

    return data;
  }

  // تصحيح - لا يعدل الأصلي - ينشئ Correction Event
  async correctEvent(originalEventId: string, correction: { correctedBy: string; reason: string; oldValue: any; newValue: any }): Promise<CorrectionEvent> {
    const original = this.logs.find(l => l.id === originalEventId);
    if (!original) throw new Error('Original event not found');

    const correctionEvent: CorrectionEvent = {
      id: `CORRECTION-${Date.now()}-${Math.random().toString(36).substr(2, 6)}`,
      originalEventId,
      correctedBy: correction.correctedBy,
      correctionReason: correction.reason,
      oldValue: this.sanitize(correction.oldValue),
      newValue: this.sanitize(correction.newValue),
      createdAt: new Date(),
    };

    this.corrections.push(correctionEvent);

    // تسجيل التصحيح كـ Audit Log جديد
    await this.log({
      userId: correction.correctedBy,
      action: 'ADMIN_ACTION',
      resourceType: 'AUDIT_LOG',
      resourceId: originalEventId,
      oldValue: correction.oldValue,
      newValue: correction.newValue,
      metadata: { correctionReason: correction.reason, correctionId: correctionEvent.id },
    });

    return correctionEvent;
  }

  getLogs(filters?: {
    userId?: string;
    action?: AuditAction;
    resourceId?: string;
    operationId?: string;
    from?: Date;
    to?: Date;
  }): AuditLogEntry[] {
    let filtered = [...this.logs];

    if (filters?.userId) filtered = filtered.filter(l => l.userId === filters.userId);
    if (filters?.action) filtered = filtered.filter(l => l.action === filters.action);
    if (filters?.resourceId) filtered = filtered.filter(l => l.resourceId === filters.resourceId);
    if (filters?.operationId) filtered = filtered.filter(l => l.operationId === filters.operationId);
    if (filters?.from) filtered = filtered.filter(l => l.timestamp >= filters.from!);
    if (filters?.to) filtered = filtered.filter(l => l.timestamp <= filters.to!);

    return filtered.sort((a, b) => b.timestamp.getTime() - a.timestamp.getTime());
  }

  getLogsByOperation(operationId: string): AuditLogEntry[] {
    return this.getLogs({ operationId });
  }

  getCorrections(originalEventId: string): CorrectionEvent[] {
    return this.corrections.filter(c => c.originalEventId === originalEventId);
  }

  // للتقارير - Export يسجل Audit Log
  async logExport(params: { userId: string; userName: string; exportType: string; filters: any }): Promise<AuditLogEntry> {
    return await this.log({
      userId: params.userId,
      userName: params.userName,
      action: `EXPORT_${params.exportType.toUpperCase()}` as AuditAction,
      resourceType: 'REPORT',
      metadata: { exportType: params.exportType, filters: params.filters },
    });
  }
}

export const auditLogService = new AuditLogService();
