import { createHash } from 'crypto';
import { Prisma } from '@prisma/client';
import { safeApiErrorCode } from './api-auth';
import { db } from './db';
import {
  deriveRenewalEligibilityKey,
  deriveRenewalRequestKey,
  deriveRenewalStatusKey,
  getRenewalProvider,
  publicRenewalEligibility,
  type RenewalResult,
} from './renewal';
import {
  deriveViolationInquiryKey,
  deriveViolationInquiryStateKey,
  deriveViolationPaymentKey,
  getViolationProvider,
  publicViolation,
  type ViolationPaymentResult,
} from './violations';

const RENEWAL_OPERATION_TYPE = 'REGISTRATION_RENEWAL';
const VIOLATION_PAYMENT_OPERATION_TYPE = 'VIOLATION_PAYMENT';
const VIOLATION_INQUIRY_STATE_OPERATION_TYPE = 'VIOLATION_INQUIRY_STATE';

export function deriveRenewalCycleDigest(vehicleId: string, plateNumber: string, vin: string, cycleId: string) {
  return createHash('sha256').update(`${vehicleId}\0${plateNumber}\0${vin}\0${cycleId}`).digest('hex');
}

const providerFailures = new Set([
  'TRAFFIC_PROVIDER_UNAVAILABLE',
  'TRAFFIC_PROVIDER_RESPONSE_INVALID',
  'TRAFFIC_PROVIDER_SUBJECT_MISMATCH',
  'TRAFFIC_PROVIDER_AMOUNT_MISMATCH',
  'TRAFFIC_PROVIDER_REFERENCE_REPLAY',
  'TRAFFIC_PROVIDER_REFERENCE_CHANGED',
  'TRAFFIC_PROVIDER_PAYMENT_STATE_CONFLICT',
  'TRAFFIC_PROVIDER_SEQUENCE_CONFLICT',
]);

export function vehicleComplianceApiError(error: unknown) {
  const code = safeApiErrorCode(error);
  const status = code === 'UNAUTHORIZED' ? 401
    : code === 'RATE_LIMITED' ? 429
      : code.startsWith('NOT_CONFIGURED:') ? 503
        : providerFailures.has(code) ? 502
          : ['VEHICLE_NOT_FOUND', 'VIOLATION_NOT_FOUND', 'REGISTRATION_RENEWAL_NOT_FOUND'].includes(code) ? 404
            : ['VIOLATION_NOT_PAYABLE', 'VIOLATION_PROVIDER_REFERENCE_REQUIRED', 'VIOLATION_AMOUNT_INVALID', 'VIOLATION_CHANGED_RETRY', 'VIOLATION_PAYMENT_REVIEW_REQUIRED', 'VIOLATION_PAYMENT_RECONCILIATION_REQUIRED', 'REGISTRATION_RENEWAL_NOT_ELIGIBLE', 'REGISTRATION_RENEWAL_ALREADY_REQUESTED', 'REGISTRATION_RENEWAL_REVIEW_REQUIRED', 'VEHICLE_OWNERSHIP_NOT_VERIFIED', 'VEHICLE_IDENTITY_CHANGED_DURING_REQUEST', 'VEHICLE_OPERATION_IN_PROGRESS', 'VEHICLE_NOT_ACTIVE', 'VEHICLE_RESTRICTED', 'VEHICLE_OWNERSHIP_CHANGED_DURING_REQUEST', 'VEHICLE_OPERATION_CHANGED_DURING_REQUEST', 'IDEMPOTENCY_KEY_REUSED'].includes(code) ? 409
              : 500;
  return Response.json({ ok: false, error: code === 'INTERNAL_ERROR' ? 'VEHICLE_COMPLIANCE_FAILED' : code }, {
    status,
    headers: { 'Cache-Control': 'private, no-store' },
  });
}

type JsonRecord = Record<string, unknown>;

function metadataRecord(value: Prisma.JsonValue | null): JsonRecord {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as JsonRecord : {};
}

function renewalStatus(value: unknown, fallback: string) {
  return ['PAYMENT_REQUIRED', 'PENDING_GOVERNMENT', 'COMPLETED', 'REJECTED', 'FAILED'].includes(String(value))
    ? String(value)
    : fallback;
}

function renewalResultDigest(result: RenewalResult) {
  return createHash('sha256').update(JSON.stringify({
    status: result.status,
    providerReference: result.providerReference ?? null,
    newExpiryDate: result.newExpiryDate?.toISOString() ?? null,
  })).digest('hex');
}

function publicRenewalOperation(operation: {
  status: string;
  metadata: Prisma.JsonValue | null;
  createdAt: Date;
  updatedAt: Date;
} | null, replayed = false) {
  if (!operation) return null;
  const metadata = metadataRecord(operation.metadata);
  const fallback = operation.status === 'SUCCESS' ? 'COMPLETED'
    : operation.status === 'FAILED' || operation.status === 'MANUAL_REVIEW' ? 'FAILED'
      : 'PENDING_GOVERNMENT';
  return {
    status: renewalStatus(metadata.providerStatus, fallback),
    feesYER: typeof metadata.feesYER === 'number' ? metadata.feesYER : null,
    newExpiryDate: typeof metadata.newExpiryDate === 'string' ? metadata.newExpiryDate : null,
    submittedAt: operation.createdAt,
    updatedAt: operation.updatedAt,
    replayed,
  };
}

async function ownedVehicle(userId: string, vehicleId: string) {
  const vehicle = await db.vehicle.findFirst({
    where: { id: vehicleId, ownerId: userId },
    select: {
      id: true, ownerId: true, plateNumber: true, vin: true, status: true, isReserved: true,
      hasLegalBlock: true, governmentStatus: true,
    },
  });
  if (!vehicle) throw new Error('VEHICLE_NOT_FOUND');
  if (vehicle.governmentStatus !== 'VERIFIED') throw new Error('VEHICLE_OWNERSHIP_NOT_VERIFIED');
  return vehicle;
}

function assertComplianceActionAvailable(vehicle: { status: string; isReserved: boolean }) {
  if (vehicle.status !== 'ACTIVE') throw new Error('VEHICLE_NOT_ACTIVE');
  if (vehicle.isReserved) throw new Error('VEHICLE_OPERATION_IN_PROGRESS');
}

function assertRenewalAvailable(vehicle: { status: string; isReserved: boolean; hasLegalBlock: boolean; governmentStatus: string }) {
  assertComplianceActionAvailable(vehicle);
  if (vehicle.hasLegalBlock || vehicle.governmentStatus !== 'VERIFIED') throw new Error('VEHICLE_RESTRICTED');
}

export async function inquireAndSyncVehicleViolations(params: { userId: string; vehicleId: string }) {
  const vehicle = await ownedVehicle(params.userId, params.vehicleId);
  const provider = getViolationProvider();
  const inquiry = await provider.inquiryViolations({
    vehicleId: vehicle.id,
    plateNumber: vehicle.plateNumber,
    vin: vehicle.vin,
    idempotencyKey: deriveViolationInquiryKey(vehicle.id, vehicle.plateNumber, vehicle.vin),
  });
  const snapshots = inquiry.violations;
  const stateKey = deriveViolationInquiryStateKey(vehicle.id, vehicle.plateNumber, vehicle.vin);
  const subjectDigest = createHash('sha256').update(`${vehicle.id}|${vehicle.plateNumber}|${vehicle.vin}`).digest('hex');
  const snapshotDigest = createHash('sha256').update(JSON.stringify([...snapshots]
    .sort((a, b) => a.externalReference.localeCompare(b.externalReference))
    .map(item => ({
      externalReference: item.externalReference, type: item.type, summary: item.summary, amountYER: item.amountYER,
      issuedAt: item.issuedAt.toISOString(), dueAt: item.dueAt?.toISOString() ?? null, status: item.status,
    })))).digest('hex');

  const rows = await db.$transaction(async tx => {
    await tx.$queryRaw`SELECT id FROM "Vehicle" WHERE id = ${vehicle.id} FOR UPDATE`;
    const current = await tx.vehicle.findUnique({
      where: { id: vehicle.id },
      select: { ownerId: true, plateNumber: true, vin: true, governmentStatus: true },
    });
    if (!current || current.ownerId !== params.userId) throw new Error('VEHICLE_NOT_FOUND');
    if (current.governmentStatus !== 'VERIFIED' || current.plateNumber !== vehicle.plateNumber || current.vin !== vehicle.vin) {
      throw new Error('VEHICLE_IDENTITY_CHANGED_DURING_REQUEST');
    }

    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${stateKey}))`;
    const state = await tx.operation.findUnique({ where: { idempotencyKey: stateKey } });
    if (state && state.type !== VIOLATION_INQUIRY_STATE_OPERATION_TYPE) throw new Error('IDEMPOTENCY_KEY_REUSED');
    const stateMetadata = metadataRecord(state?.metadata ?? null);
    if (state && (stateMetadata.vehicleId !== vehicle.id || stateMetadata.subjectDigest !== subjectDigest)) throw new Error('IDEMPOTENCY_KEY_REUSED');
    const previousSequence = typeof stateMetadata.snapshotSequence === 'number' ? stateMetadata.snapshotSequence : -1;
    if (inquiry.snapshotSequence < previousSequence) {
      return tx.violation.findMany({ where: { vehicleId: vehicle.id }, orderBy: [{ issuedAt: 'desc' }, { id: 'desc' }] });
    }
    if (inquiry.snapshotSequence === previousSequence) {
      if (stateMetadata.snapshotDigest !== snapshotDigest) throw new Error('TRAFFIC_PROVIDER_SEQUENCE_CONFLICT');
      return tx.violation.findMany({ where: { vehicleId: vehicle.id }, orderBy: [{ issuedAt: 'desc' }, { id: 'desc' }] });
    }

    const references = snapshots.map(item => item.externalReference);
    for (const reference of [...references].sort()) {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`VIOLATION_REFERENCE:${reference}`}))`;
    }
    const existing = references.length ? await tx.violation.findMany({ where: { externalReference: { in: references } } }) : [];
    if (existing.some(item => item.vehicleId !== vehicle.id)) throw new Error('TRAFFIC_PROVIDER_REFERENCE_REPLAY');
    const byReference = new Map(existing.map(item => [item.externalReference, item]));
    const synchronized = [];
    for (const snapshot of snapshots) {
      const data = {
        userId: params.userId,
        type: snapshot.type,
        description: snapshot.summary,
        amount: snapshot.amountYER,
        status: snapshot.status,
        issuedAt: snapshot.issuedAt,
        dueAt: snapshot.dueAt,
      };
      const found = byReference.get(snapshot.externalReference);
      if (found?.status === 'PAID' && (snapshot.status !== 'PAID' || !found.amount.eq(snapshot.amountYER))) {
        throw new Error('TRAFFIC_PROVIDER_PAYMENT_STATE_CONFLICT');
      }
      // Without a monotonic provider snapshot version, fail closed instead of
      // letting a late PENDING response reopen a locally disputed/cancelled row.
      if (found && snapshot.status === 'PENDING' && ['DISPUTED', 'CANCELLED'].includes(found.status)) {
        synchronized.push(found);
        continue;
      }
      const row = found
        ? await tx.violation.update({ where: { id: found.id }, data })
        : await tx.violation.create({ data: { ...data, vehicleId: vehicle.id, externalReference: snapshot.externalReference } });
      synchronized.push(row);
    }

    await tx.violation.updateMany({
      where: {
        vehicleId: vehicle.id,
        status: 'PENDING',
        externalReference: references.length ? { not: null, notIn: references } : { not: null },
      },
      data: { status: 'CANCELLED' },
    });
    const metadata: Prisma.InputJsonObject = { vehicleId: vehicle.id, subjectDigest, snapshotSequence: inquiry.snapshotSequence, snapshotDigest };
    if (state) {
      await tx.operation.update({ where: { id: state.id }, data: { userId: params.userId, status: 'SUCCESS', metadata } });
    } else {
      await tx.operation.create({
        data: {
          operationNumber: `VIS-${subjectDigest.slice(0, 24)}`,
          type: VIOLATION_INQUIRY_STATE_OPERATION_TYPE,
          userId: params.userId,
          status: 'SUCCESS',
          idempotencyKey: stateKey,
          metadata,
        },
      });
    }
    return synchronized;
  });

  return rows.map(publicViolation);
}

function paymentPublic(result: ViolationPaymentResult, replayed = false) {
  return {
    status: result.status,
    checkoutUrl: result.checkoutUrl,
    replayed,
  };
}

export async function startVehicleViolationPayment(params: { userId: string; vehicleId: string; violationId: string }) {
  const violation = await db.violation.findFirst({
    where: { id: params.violationId, vehicleId: params.vehicleId, vehicle: { ownerId: params.userId } },
    select: {
      id: true, vehicleId: true, externalReference: true, amount: true, status: true,
      vehicle: { select: { ownerId: true, plateNumber: true, vin: true, status: true, isReserved: true, governmentStatus: true } },
    },
  });
  if (!violation) throw new Error('VIOLATION_NOT_FOUND');
  if (violation.vehicle.governmentStatus !== 'VERIFIED') throw new Error('VEHICLE_OWNERSHIP_NOT_VERIFIED');
  assertComplianceActionAvailable(violation.vehicle);
  if (!violation.externalReference) throw new Error('VIOLATION_PROVIDER_REFERENCE_REQUIRED');
  if (violation.status === 'PAID') return paymentPublic({ status: 'PAID' }, true);
  if (violation.status !== 'PENDING') throw new Error('VIOLATION_NOT_PAYABLE');
  const initialAmountYER = Number(violation.amount);
  if (!Number.isSafeInteger(initialAmountYER) || initialAmountYER <= 0) throw new Error('VIOLATION_AMOUNT_INVALID');
  const provider = getViolationProvider();
  const idempotencyKey = deriveViolationPaymentKey(params.vehicleId, params.violationId, params.userId, violation.externalReference, initialAmountYER);
  const violationReferenceDigest = createHash('sha256').update(violation.externalReference).digest('hex');

  const claim = await db.$transaction(async tx => {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${idempotencyKey}))`;
    await tx.$queryRaw`SELECT id FROM "Vehicle" WHERE id = ${params.vehicleId} FOR UPDATE`;
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`VIOLATION_REFERENCE:${violation.externalReference}`}))`;
    await tx.$queryRaw`SELECT id FROM "Violation" WHERE id = ${params.violationId} FOR UPDATE`;
    const current = await tx.violation.findFirst({
      where: { id: params.violationId, vehicleId: params.vehicleId, vehicle: { ownerId: params.userId } },
      select: {
        id: true, externalReference: true, amount: true, status: true,
        vehicle: { select: { ownerId: true, plateNumber: true, vin: true, status: true, isReserved: true, governmentStatus: true } },
      },
    });
    if (!current) throw new Error('VIOLATION_NOT_FOUND');
    if (current.vehicle.governmentStatus !== 'VERIFIED') throw new Error('VEHICLE_OWNERSHIP_NOT_VERIFIED');
    assertComplianceActionAvailable(current.vehicle);
    if (current.status === 'PAID') return { done: true as const, result: { status: 'PAID' as const }, operation: null, violation: current };
    if (current.status !== 'PENDING' || !current.externalReference) throw new Error('VIOLATION_NOT_PAYABLE');
    if (current.externalReference !== violation.externalReference || current.amount.toString() !== violation.amount.toString()) throw new Error('VIOLATION_CHANGED_RETRY');
    const baseOperation = await tx.operation.findUnique({ where: { idempotencyKey } });
    if (baseOperation && (baseOperation.type !== VIOLATION_PAYMENT_OPERATION_TYPE || baseOperation.userId !== params.userId)) {
      throw new Error('IDEMPOTENCY_KEY_REUSED');
    }
    const existing = (await tx.operation.findFirst({
      where: {
        type: VIOLATION_PAYMENT_OPERATION_TYPE,
        userId: params.userId,
        metadata: { path: ['violationId'], equals: params.violationId },
      },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
    })) ?? baseOperation;
    if (existing && (existing.type !== VIOLATION_PAYMENT_OPERATION_TYPE || existing.userId !== params.userId)) throw new Error('IDEMPOTENCY_KEY_REUSED');
    if (existing?.status === 'MANUAL_REVIEW') throw new Error('VIOLATION_PAYMENT_REVIEW_REQUIRED');
    const unresolved = await tx.operation.findFirst({
      where: {
        type: VIOLATION_PAYMENT_OPERATION_TYPE,
        userId: params.userId,
        status: { in: ['PENDING', 'MANUAL_REVIEW'] },
        metadata: { path: ['violationId'], equals: params.violationId },
      },
      select: { id: true },
    });
    if (unresolved && unresolved.id !== existing?.id) throw new Error('VIOLATION_PAYMENT_REVIEW_REQUIRED');
    if (existing?.status === 'SUCCESS') {
      await tx.violation.update({ where: { id: current.id }, data: { status: 'PAID' } });
      return { done: true as const, result: { status: 'PAID' as const }, operation: existing, violation: current };
    }
    const previousMetadata = metadataRecord(existing?.metadata ?? null);
    const previousAttempt = Number(previousMetadata.attemptNumber);
    const attemptNumber = existing?.status === 'FAILED'
      ? (Number.isInteger(previousAttempt) && previousAttempt > 0 ? previousAttempt + 1 : 2)
      : (Number.isInteger(previousAttempt) && previousAttempt > 0 ? previousAttempt : 1);
    const requestIdempotencyKey = existing?.status === 'FAILED'
      ? `${idempotencyKey}:RETRY:${attemptNumber}`
      : existing?.idempotencyKey ?? idempotencyKey;
    const collision = await tx.operation.findUnique({ where: { idempotencyKey: requestIdempotencyKey } });
    if (collision && collision.id !== existing?.id) throw new Error('IDEMPOTENCY_KEY_REUSED');
    const metadata: Prisma.InputJsonObject = {
      vehicleId: params.vehicleId,
      violationId: params.violationId,
      providerStatus: 'PENDING',
      amountYER: initialAmountYER,
      currency: 'YER',
      violationReferenceDigest,
      attemptNumber,
    };
    const operation = existing?.status === 'FAILED'
      ? await tx.operation.create({
        data: {
          operationNumber: `VIO-${idempotencyKey.slice(-18)}-${attemptNumber}`,
          type: VIOLATION_PAYMENT_OPERATION_TYPE,
          userId: params.userId,
          status: 'PENDING',
          idempotencyKey: requestIdempotencyKey,
          metadata,
        },
      })
      : existing
        ? await tx.operation.update({ where: { id: existing.id }, data: { status: 'PENDING', idempotencyKey: requestIdempotencyKey, metadata } })
      : await tx.operation.create({
        data: {
          operationNumber: `VIO-${idempotencyKey.slice(-24)}`,
          type: VIOLATION_PAYMENT_OPERATION_TYPE,
          userId: params.userId,
          status: 'PENDING',
          idempotencyKey: requestIdempotencyKey,
          metadata,
        },
      });
    // PENDING is deliberately retried only with the exact same provider key;
    // this reconciles a timeout or regenerates an expired checkout safely.
    return { done: false as const, result: null, operation, violation: current, idempotencyKey: requestIdempotencyKey, attemptNumber };
  });
  if (claim.done) return paymentPublic(claim.result, true);
  const amountYER = Number(claim.violation.amount);
  if (!Number.isSafeInteger(amountYER) || amountYER <= 0 || !claim.violation.externalReference) throw new Error('VIOLATION_AMOUNT_INVALID');

  let result: ViolationPaymentResult;
  try {
    result = await provider.startPayment({
      vehicleId: params.vehicleId,
      plateNumber: claim.violation.vehicle.plateNumber,
      vin: claim.violation.vehicle.vin,
      externalReference: claim.violation.externalReference,
      amountYER,
      idempotencyKey: claim.idempotencyKey,
    });
  } catch (error) {
    const code = error instanceof Error ? error.message : 'TRAFFIC_PROVIDER_UNAVAILABLE';
    const ambiguous = code === 'TRAFFIC_PROVIDER_UNAVAILABLE';
    await db.operation.updateMany({
      where: { id: claim.operation.id, status: 'PENDING' },
      data: {
        status: ambiguous ? 'PENDING' : 'MANUAL_REVIEW',
        metadata: {
          vehicleId: params.vehicleId, violationId: params.violationId, providerStatus: ambiguous ? 'PENDING' : 'FAILED',
          amountYER, currency: 'YER', violationReferenceDigest, attemptNumber: claim.attemptNumber,
        },
      },
    });
    throw error;
  }

  const finalized = await db.$transaction(async tx => {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${claim.idempotencyKey}))`;
    await tx.$queryRaw`SELECT id FROM "Vehicle" WHERE id = ${params.vehicleId} FOR UPDATE`;
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`VIOLATION_REFERENCE:${claim.violation.externalReference}`}))`;
    await tx.$queryRaw`SELECT id FROM "Violation" WHERE id = ${params.violationId} FOR UPDATE`;
    const [current, vehicle, operation] = await Promise.all([
      tx.violation.findFirst({
        where: { id: params.violationId, vehicleId: params.vehicleId },
        select: { id: true, status: true, externalReference: true, amount: true },
      }),
      tx.vehicle.findUnique({
        where: { id: params.vehicleId },
        select: { ownerId: true, status: true, isReserved: true, governmentStatus: true },
      }),
      tx.operation.findFirst({ where: { id: claim.operation.id, userId: params.userId, type: VIOLATION_PAYMENT_OPERATION_TYPE } }),
    ]);
    if (!current || !vehicle || !operation) throw new Error('VIOLATION_NOT_FOUND');
    if (operation.status === 'SUCCESS') return paymentPublic({ status: 'PAID' }, true);
    if (operation.status === 'MANUAL_REVIEW') return { blocked: 'VIOLATION_PAYMENT_REVIEW_REQUIRED' } as const;
    if (operation.status === 'FAILED' && result.status !== 'PAID') return paymentPublic({ status: 'FAILED' }, true);
    const sourceChanged = !['PENDING', 'PAID'].includes(current.status) || current.externalReference !== claim.violation.externalReference || current.amount.toString() !== claim.violation.amount.toString();
    const vehicleChanged = vehicle.ownerId !== params.userId || vehicle.status !== 'ACTIVE' || vehicle.isReserved || vehicle.governmentStatus !== 'VERIFIED';
    if (sourceChanged || (vehicleChanged && ['PAYMENT_REQUIRED', 'PENDING'].includes(result.status))) {
      await tx.operation.update({
        where: { id: operation.id },
        data: {
          status: 'MANUAL_REVIEW',
          providerReference: result.providerReference ?? operation.providerReference,
          metadata: {
            vehicleId: params.vehicleId, violationId: params.violationId, providerStatus: result.status,
            amountYER, currency: 'YER', violationReferenceDigest, attemptNumber: claim.attemptNumber,
            reconciliationCode: sourceChanged ? 'VIOLATION_CHANGED_DURING_PAYMENT' : 'VEHICLE_OPERATION_CHANGED',
          },
        },
      });
      return { blocked: sourceChanged ? 'VIOLATION_PAYMENT_RECONCILIATION_REQUIRED' : 'VEHICLE_OPERATION_CHANGED_DURING_REQUEST' } as const;
    }
    if (current.status === 'PAID') {
        await tx.operation.update({
          where: { id: operation.id },
          data: {
            status: 'SUCCESS',
            metadata: { vehicleId: params.vehicleId, violationId: params.violationId, providerStatus: 'PAID', amountYER, currency: 'YER', violationReferenceDigest, attemptNumber: claim.attemptNumber },
          },
        });
      return paymentPublic({ status: 'PAID' }, true);
    }
    if (operation.providerReference && result.providerReference && operation.providerReference !== result.providerReference) {
      throw new Error('TRAFFIC_PROVIDER_REFERENCE_CHANGED');
    }
    if (result.providerReference) {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`VIOLATION_PAYMENT_REFERENCE:${result.providerReference}`}))`;
      const replay = await tx.operation.findFirst({
        where: { type: VIOLATION_PAYMENT_OPERATION_TYPE, providerReference: result.providerReference, id: { not: operation.id } },
        select: { id: true, metadata: true },
      });
      if (replay && metadataRecord(replay.metadata).violationId !== params.violationId) {
        throw new Error('TRAFFIC_PROVIDER_REFERENCE_REPLAY');
      }
    }
    const operationStatus = result.status === 'PAID' ? 'SUCCESS' : result.status === 'FAILED' ? 'FAILED' : 'PENDING';
    await tx.operation.update({
      where: { id: operation.id },
      data: {
        status: operationStatus,
        providerReference: result.providerReference ?? operation.providerReference,
        metadata: {
          vehicleId: params.vehicleId, violationId: params.violationId, providerStatus: result.status,
          amountYER, currency: 'YER', violationReferenceDigest, attemptNumber: claim.attemptNumber,
        },
      },
    });
    if (result.status === 'PAID') {
      await tx.violation.update({ where: { id: current.id }, data: { status: 'PAID' } });
      await tx.auditLog.create({
        data: {
          userId: params.userId, action: 'VIOLATION_PAYMENT_CONFIRMED', entityType: 'VIOLATION', entityId: current.id,
          metadata: { operationType: VIOLATION_PAYMENT_OPERATION_TYPE, amountYER, currency: 'YER', violationReferenceDigest },
        },
      });
    }
    return paymentPublic(result);
  });
  if ('blocked' in finalized) throw new Error(finalized.blocked);
  return finalized;
}

async function latestRenewalOperation(userId: string, vehicleId: string) {
  return db.operation.findFirst({
    where: { userId, type: RENEWAL_OPERATION_TYPE, metadata: { path: ['vehicleId'], equals: vehicleId } },
    orderBy: { createdAt: 'desc' },
  });
}

async function applyRenewalResult(params: {
  operationId: string;
  userId: string;
  vehicleId: string;
  feesYER: number | null;
  result: RenewalResult;
}) {
  return db.$transaction(async tx => {
    const lockKey = `RENEWAL_OPERATION:${params.operationId}`;
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${lockKey}))`;
    await tx.$queryRaw`SELECT id FROM "Vehicle" WHERE id = ${params.vehicleId} FOR UPDATE`;
    const vehicle = await tx.vehicle.findUnique({ where: { id: params.vehicleId }, select: { ownerId: true } });
    const operation = await tx.operation.findFirst({ where: { id: params.operationId, userId: params.userId, type: RENEWAL_OPERATION_TYPE } });
    if (!operation || metadataRecord(operation.metadata).vehicleId !== params.vehicleId) throw new Error('REGISTRATION_RENEWAL_NOT_FOUND');
    const ownershipChanged = !vehicle || vehicle.ownerId !== params.userId;
    const priorMetadata = metadataRecord(operation.metadata);
    const previousSequence = typeof priorMetadata.providerSequence === 'number' ? priorMetadata.providerSequence : -1;
    const resultDigest = renewalResultDigest(params.result);
    if (params.result.providerSequence < previousSequence) return { operation, ownershipChanged, ignoredStaleSequence: true };
    if (params.result.providerSequence === previousSequence) {
      if (priorMetadata.providerResultDigest !== resultDigest) throw new Error('TRAFFIC_PROVIDER_SEQUENCE_CONFLICT');
      return { operation, ownershipChanged, ignoredStaleSequence: false };
    }
    if (operation.status === 'SUCCESS') return { operation, ownershipChanged, ignoredStaleSequence: true };
    if (operation.status === 'MANUAL_REVIEW') return { operation, ownershipChanged, ignoredStaleSequence: true };
    if (operation.status === 'FAILED' && params.result.status !== 'COMPLETED') return { operation, ownershipChanged, ignoredStaleSequence: true };
    if (operation.providerReference && params.result.providerReference && operation.providerReference !== params.result.providerReference) {
      throw new Error('TRAFFIC_PROVIDER_REFERENCE_CHANGED');
    }
    if (params.result.providerReference) {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`RENEWAL_REFERENCE:${params.result.providerReference}`}))`;
      const replay = await tx.operation.findFirst({
        where: { type: RENEWAL_OPERATION_TYPE, providerReference: params.result.providerReference, id: { not: operation.id } },
        select: { id: true, metadata: true },
      });
      const replayMetadata = metadataRecord(replay?.metadata ?? null);
      const operationMetadata = metadataRecord(operation.metadata);
      if (replay && (
        replayMetadata.vehicleId !== params.vehicleId
        || replayMetadata.renewalCycleDigest !== operationMetadata.renewalCycleDigest
      )) throw new Error('TRAFFIC_PROVIDER_REFERENCE_REPLAY');
    }
    const status = ownershipChanged && ['PAYMENT_REQUIRED', 'PENDING_GOVERNMENT'].includes(params.result.status) ? 'MANUAL_REVIEW'
      : params.result.status === 'COMPLETED' ? 'SUCCESS'
      : ['FAILED', 'REJECTED'].includes(params.result.status) ? 'FAILED'
        : 'PENDING';
    const previousStatus = renewalStatus(metadataRecord(operation.metadata).providerStatus, 'PENDING_GOVERNMENT');
    const updated = await tx.operation.update({
      where: { id: operation.id },
      data: {
        status,
        providerReference: params.result.providerReference ?? operation.providerReference,
        metadata: {
          vehicleId: params.vehicleId,
          providerStatus: params.result.status,
          providerSequence: params.result.providerSequence,
          providerResultDigest: resultDigest,
          ...(params.feesYER === null ? {} : { feesYER: params.feesYER }),
          ...(params.result.newExpiryDate ? { newExpiryDate: params.result.newExpiryDate.toISOString() } : {}),
          ...(ownershipChanged ? { reconciliationCode: 'VEHICLE_OWNER_CHANGED' } : {}),
          ...(typeof priorMetadata.renewalCycleDigest === 'string' ? { renewalCycleDigest: priorMetadata.renewalCycleDigest } : {}),
          ...(typeof priorMetadata.attemptNumber === 'number' ? { attemptNumber: priorMetadata.attemptNumber } : {}),
        },
      },
    });
    if (params.result.status === 'COMPLETED' && previousStatus !== 'COMPLETED') {
      await tx.auditLog.create({
        data: { userId: params.userId, action: 'REGISTRATION_RENEWAL_CONFIRMED', entityType: 'VEHICLE', entityId: params.vehicleId, metadata: { operationType: RENEWAL_OPERATION_TYPE } },
      });
    }
    return { operation: updated, ownershipChanged, ignoredStaleSequence: false };
  });
}

export async function getVehicleRenewalOverview(params: { userId: string; vehicleId: string }) {
  const vehicle = await ownedVehicle(params.userId, params.vehicleId);
  const provider = getRenewalProvider();
  let operation = await latestRenewalOperation(params.userId, vehicle.id);
  let checkoutUrl: string | undefined;
  if (operation?.status === 'PENDING' && operation.providerReference) {
    const statusResult = await provider.getRenewalStatus({
      vehicleId: vehicle.id,
      plateNumber: vehicle.plateNumber,
      vin: vehicle.vin,
      providerReference: operation.providerReference,
      idempotencyKey: deriveRenewalStatusKey(operation.id, operation.providerReference),
    });
    const metadata = metadataRecord(operation.metadata);
    const applied = await applyRenewalResult({
      operationId: operation.id,
      userId: params.userId,
      vehicleId: vehicle.id,
      feesYER: typeof metadata.feesYER === 'number' ? metadata.feesYER : null,
      result: statusResult,
    });
    if (applied.ownershipChanged) throw new Error('VEHICLE_OWNERSHIP_CHANGED_DURING_REQUEST');
    checkoutUrl = applied.ignoredStaleSequence ? undefined : statusResult.checkoutUrl;
    operation = applied.operation;
  }
  const eligibility = await provider.checkEligibility({
    vehicleId: vehicle.id,
    plateNumber: vehicle.plateNumber,
    vin: vehicle.vin,
    idempotencyKey: deriveRenewalEligibilityKey(vehicle.id, vehicle.plateNumber, vehicle.vin),
  });
  const request = publicRenewalOperation(operation);
  return { eligibility: publicRenewalEligibility(eligibility), request: request ? { ...request, checkoutUrl } : null };
}

export async function submitVehicleRegistrationRenewal(params: { userId: string; vehicleId: string }) {
  const vehicle = await ownedVehicle(params.userId, params.vehicleId);
  assertRenewalAvailable(vehicle);
  const provider = getRenewalProvider();
  const eligibility = await provider.checkEligibility({
    vehicleId: vehicle.id,
    plateNumber: vehicle.plateNumber,
    vin: vehicle.vin,
    idempotencyKey: deriveRenewalEligibilityKey(vehicle.id, vehicle.plateNumber, vehicle.vin),
  });
  if (!eligibility.eligible || !eligibility.cycleId || !eligibility.eligibilityReference) {
    throw new Error('REGISTRATION_RENEWAL_NOT_ELIGIBLE');
  }
  const idempotencyKey = deriveRenewalRequestKey(vehicle.id, vehicle.plateNumber, vehicle.vin, eligibility.cycleId);
  const renewalCycleDigest = deriveRenewalCycleDigest(vehicle.id, vehicle.plateNumber, vehicle.vin, eligibility.cycleId);
  const claim = await db.$transaction(async tx => {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${idempotencyKey}))`;
    await tx.$queryRaw`SELECT id FROM "Vehicle" WHERE id = ${vehicle.id} FOR UPDATE`;
    const current = await tx.vehicle.findFirst({
      where: { id: vehicle.id, ownerId: params.userId },
      select: { id: true, plateNumber: true, vin: true, status: true, isReserved: true, hasLegalBlock: true, governmentStatus: true },
    });
    if (!current) throw new Error('VEHICLE_NOT_FOUND');
    assertRenewalAvailable(current);
    if (current.plateNumber !== vehicle.plateNumber || current.vin !== vehicle.vin) throw new Error('VEHICLE_IDENTITY_CHANGED_DURING_REQUEST');
    const baseOperation = await tx.operation.findUnique({ where: { idempotencyKey } });
    if (baseOperation && baseOperation.type !== RENEWAL_OPERATION_TYPE) throw new Error('IDEMPOTENCY_KEY_REUSED');
    const existing = (await tx.operation.findFirst({
      where: { type: RENEWAL_OPERATION_TYPE, metadata: { path: ['renewalCycleDigest'], equals: renewalCycleDigest } },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
    })) ?? baseOperation;
    if (existing && existing.type !== RENEWAL_OPERATION_TYPE) throw new Error('IDEMPOTENCY_KEY_REUSED');
    if (existing && existing.userId !== params.userId) throw new Error('REGISTRATION_RENEWAL_ALREADY_REQUESTED');
    if (existing?.status === 'MANUAL_REVIEW') throw new Error('REGISTRATION_RENEWAL_REVIEW_REQUIRED');
    const previousMetadata = metadataRecord(existing?.metadata ?? null);
    if (existing?.status === 'FAILED' && previousMetadata.providerStatus === 'REJECTED') return { done: true as const, operation: existing };
    if (existing?.status === 'SUCCESS') return { done: true as const, operation: existing };
    const previousAttempt = Number(previousMetadata.attemptNumber);
    const attemptNumber = existing?.status === 'FAILED'
      ? (Number.isInteger(previousAttempt) && previousAttempt > 0 ? previousAttempt + 1 : 2)
      : (Number.isInteger(previousAttempt) && previousAttempt > 0 ? previousAttempt : 1);
    const requestIdempotencyKey = existing?.status === 'FAILED'
      ? `${idempotencyKey}:RETRY:${attemptNumber}`
      : existing?.idempotencyKey ?? idempotencyKey;
    const collision = await tx.operation.findUnique({ where: { idempotencyKey: requestIdempotencyKey } });
    if (collision && collision.id !== existing?.id) throw new Error('IDEMPOTENCY_KEY_REUSED');
    const metadata: Prisma.InputJsonObject = {
      vehicleId: vehicle.id, feesYER: eligibility.feesYER, providerStatus: 'PENDING_GOVERNMENT', renewalCycleDigest, attemptNumber,
    };
    // PENDING is reconciled with the same provider key. A confirmed FAILED
    // response gets a separate immutable attempt; MANUAL_REVIEW stays closed.
    const operation = existing?.status === 'FAILED'
      ? await tx.operation.create({
        data: {
          operationNumber: `REN-${idempotencyKey.slice(-18)}-${attemptNumber}`,
          type: RENEWAL_OPERATION_TYPE,
          userId: params.userId,
          status: 'PENDING',
          idempotencyKey: requestIdempotencyKey,
          metadata,
        },
      })
      : existing
        ? await tx.operation.update({ where: { id: existing.id }, data: { status: 'PENDING', idempotencyKey: requestIdempotencyKey, metadata } })
      : await tx.operation.create({
        data: {
          operationNumber: `REN-${idempotencyKey.slice(-24)}`,
          type: RENEWAL_OPERATION_TYPE,
          userId: params.userId,
          status: 'PENDING',
          idempotencyKey: requestIdempotencyKey,
          metadata,
        },
      });
    return { done: false as const, operation, idempotencyKey: requestIdempotencyKey, attemptNumber };
  });
  if (claim.done) return publicRenewalOperation(claim.operation, true);

  let result: RenewalResult;
  try {
    result = await provider.submitRenewal({
      vehicleId: vehicle.id,
      plateNumber: vehicle.plateNumber,
      vin: vehicle.vin,
      eligibility,
      idempotencyKey: claim.idempotencyKey,
    });
  } catch (error) {
    const code = error instanceof Error ? error.message : 'TRAFFIC_PROVIDER_UNAVAILABLE';
    const ambiguous = code === 'TRAFFIC_PROVIDER_UNAVAILABLE';
    await db.operation.updateMany({
      where: { id: claim.operation.id, status: 'PENDING' },
      data: {
        status: ambiguous ? 'PENDING' : 'MANUAL_REVIEW',
        metadata: {
          vehicleId: vehicle.id, feesYER: eligibility.feesYER, providerStatus: ambiguous ? 'PENDING_GOVERNMENT' : 'FAILED',
          renewalCycleDigest, attemptNumber: claim.attemptNumber,
        },
      },
    });
    throw error;
  }
  const applied = await applyRenewalResult({
    operationId: claim.operation.id,
    userId: params.userId,
    vehicleId: vehicle.id,
    feesYER: eligibility.feesYER,
    result,
  });
  if (applied.ownershipChanged) throw new Error('VEHICLE_OWNERSHIP_CHANGED_DURING_REQUEST');
  const request = publicRenewalOperation(applied.operation);
  return request ? { ...request, checkoutUrl: result.checkoutUrl } : null;
}
