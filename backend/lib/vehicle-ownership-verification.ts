import { createHash } from 'crypto';
import { z } from 'zod';
import { db } from './db';
import { isIdentityVerified } from './identity-policy';
import { getTrafficProviderHttpClient, type TrafficProviderHttpClient } from './traffic-provider-http';

const OPERATION_TYPE = 'VEHICLE_OWNERSHIP_VERIFICATION';
const CLAIM_STALE_MS = 30_000;

const providerResponseSchema = z.object({
  decision: z.enum(['VERIFIED', 'REJECTED']),
  providerReference: z.string().trim().min(1).max(300),
  subject: z.object({
    vehicleId: z.string().min(1).max(100),
    plateNumber: z.string().min(1).max(50),
    vin: z.string().min(10).max(50),
    userId: z.string().min(1).max(100),
    nationalId: z.string().min(6).max(40),
  }).strict(),
}).strict();

type OwnershipSubject = {
  vehicleId: string;
  plateNumber: string;
  vin: string;
  userId: string;
  nationalId: string;
};

export type VehicleOwnershipProviderResult = z.infer<typeof providerResponseSchema>;

export interface VehicleOwnershipProvider {
  verifyOwnership(subject: OwnershipSubject, idempotencyKey: string): Promise<VehicleOwnershipProviderResult>;
}

export class HttpVehicleOwnershipProvider implements VehicleOwnershipProvider {
  constructor(private readonly client: TrafficProviderHttpClient) {}

  async verifyOwnership(subject: OwnershipSubject, idempotencyKey: string) {
    const raw = await this.client.post('VERIFY_VEHICLE_OWNERSHIP', {
      vehicle: { id: subject.vehicleId, plateNumber: subject.plateNumber, vin: subject.vin },
      owner: { userId: subject.userId, nationalId: subject.nationalId },
    }, idempotencyKey);
    const parsed = providerResponseSchema.safeParse(raw);
    if (!parsed.success) throw new Error('TRAFFIC_PROVIDER_RESPONSE_INVALID');
    if (
      parsed.data.subject.vehicleId !== subject.vehicleId
      || parsed.data.subject.plateNumber !== subject.plateNumber
      || parsed.data.subject.vin !== subject.vin
      || parsed.data.subject.userId !== subject.userId
      || parsed.data.subject.nationalId !== subject.nationalId
    ) throw new Error('TRAFFIC_PROVIDER_SUBJECT_MISMATCH');
    return parsed.data;
  }
}

export function getVehicleOwnershipProvider() {
  return new HttpVehicleOwnershipProvider(getTrafficProviderHttpClient());
}

function metadataRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function subjectDigest(subject: OwnershipSubject) {
  return createHash('sha256')
    .update(`${subject.vehicleId}|${subject.plateNumber}|${subject.vin}|${subject.userId}|${subject.nationalId}`)
    .digest('hex');
}

export function deriveVehicleOwnershipVerificationKey(subject: OwnershipSubject) {
  return `VEHICLE_OWNERSHIP_VERIFY:${subjectDigest(subject)}`;
}

function publicResult(params: {
  decision: 'VERIFIED' | 'REJECTED' | 'PENDING';
  vehicleId: string;
  status: string;
  governmentStatus: string;
  replayed: boolean;
}) {
  return {
    decision: params.decision,
    replayed: params.replayed,
    vehicle: {
      id: params.vehicleId,
      status: params.status,
      governmentStatus: params.governmentStatus,
    },
  };
}

export async function verifyVehicleOwnership(params: {
  userId: string;
  vehicleId: string;
  provider?: VehicleOwnershipProvider;
}) {
  const claim = await db.$transaction(async tx => {
    await tx.$queryRaw`SELECT id FROM "Vehicle" WHERE id = ${params.vehicleId} FOR UPDATE`;
    const vehicle = await tx.vehicle.findUnique({
      where: { id: params.vehicleId },
      select: {
        id: true, ownerId: true, plateNumber: true, vin: true, status: true,
        isReserved: true, governmentStatus: true,
        owner: { select: { id: true, status: true, phoneStatus: true, identityStatus: true, nationalId: true } },
      },
    });
    if (!vehicle || vehicle.ownerId !== params.userId) throw new Error('VEHICLE_NOT_FOUND');
    if (vehicle.owner.status !== 'ACTIVE') throw new Error('UNAUTHORIZED');
    if (vehicle.owner.phoneStatus !== 'VERIFIED') throw new Error('PHONE_NOT_VERIFIED');
    if (!isIdentityVerified(vehicle.owner) || !vehicle.owner.nationalId) throw new Error('IDENTITY_NOT_VERIFIED');
    if (vehicle.isReserved || vehicle.status === 'SOLD') throw new Error('VEHICLE_LOCKED');
    if (['RESTRICTED', 'BLOCKED'].includes(vehicle.governmentStatus)) throw new Error('VEHICLE_RESTRICTED');
    if (vehicle.governmentStatus === 'VERIFIED' && vehicle.status === 'ACTIVE') {
      return { done: true as const, result: publicResult({ decision: 'VERIFIED', vehicleId: vehicle.id, status: vehicle.status, governmentStatus: vehicle.governmentStatus, replayed: true }) };
    }

    const subject: OwnershipSubject = {
      vehicleId: vehicle.id,
      plateNumber: vehicle.plateNumber,
      vin: vehicle.vin,
      userId: vehicle.ownerId,
      nationalId: vehicle.owner.nationalId,
    };
    const digest = subjectDigest(subject);
    const idempotencyKey = deriveVehicleOwnershipVerificationKey(subject);
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${idempotencyKey}))`;
    const existing = await tx.operation.findUnique({ where: { idempotencyKey } });
    if (existing) {
      const metadata = metadataRecord(existing.metadata);
      if (metadata.vehicleId !== vehicle.id || metadata.subjectDigest !== digest || existing.userId !== params.userId) {
        throw new Error('IDEMPOTENCY_KEY_REUSED');
      }
      if (existing.status === 'SUCCESS') {
        throw new Error('VEHICLE_OWNERSHIP_REVIEW_REQUIRED');
      }
      if (existing.status === 'MANUAL_REVIEW') throw new Error('VEHICLE_OWNERSHIP_REVIEW_REQUIRED');
      if (existing.status === 'FAILED' && metadata.providerDecision === 'REJECTED') {
        return { done: true as const, result: publicResult({ decision: 'REJECTED', vehicleId: vehicle.id, status: vehicle.status, governmentStatus: vehicle.governmentStatus, replayed: true }) };
      }
      if (existing.status === 'PENDING' && Date.now() - existing.updatedAt.getTime() < CLAIM_STALE_MS) {
        return { done: true as const, result: publicResult({ decision: 'PENDING', vehicleId: vehicle.id, status: vehicle.status, governmentStatus: vehicle.governmentStatus, replayed: true }) };
      }
      const operation = await tx.operation.update({
        where: { id: existing.id },
        data: { status: 'PENDING', providerReference: null, metadata: { vehicleId: vehicle.id, subjectDigest: digest, providerDecision: 'PENDING' } },
      });
      return { done: false as const, operationId: operation.id, subject, digest, idempotencyKey };
    }

    const operation = await tx.operation.create({
      data: {
        operationNumber: `VOV-${digest.slice(0, 24)}`,
        type: OPERATION_TYPE,
        userId: params.userId,
        status: 'PENDING',
        idempotencyKey,
        metadata: { vehicleId: vehicle.id, subjectDigest: digest, providerDecision: 'PENDING' },
      },
    });
    return { done: false as const, operationId: operation.id, subject, digest, idempotencyKey };
  });

  if (claim.done) return claim.result;

  let providerResult: VehicleOwnershipProviderResult;
  try {
    providerResult = await (params.provider ?? getVehicleOwnershipProvider()).verifyOwnership(claim.subject, claim.idempotencyKey);
  } catch (error) {
    const code = error instanceof Error && /^[A-Z][A-Z0-9_]*(?::[A-Z0-9_]+)?$/.test(error.message)
      ? error.message
      : 'TRAFFIC_PROVIDER_UNAVAILABLE';
    await db.operation.updateMany({
      where: { id: claim.operationId, status: 'PENDING' },
      data: { status: 'FAILED', providerReference: null, metadata: { vehicleId: claim.subject.vehicleId, subjectDigest: claim.digest, providerDecision: 'PROVIDER_FAILED', failureCode: code } },
    });
    throw error;
  }

  const finalized = await db.$transaction(async tx => {
    await tx.$queryRaw`SELECT id FROM "Vehicle" WHERE id = ${claim.subject.vehicleId} FOR UPDATE`;
    await tx.$queryRaw`SELECT id FROM "User" WHERE id = ${claim.subject.userId} FOR UPDATE`;
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`VEHICLE_OWNERSHIP_REFERENCE:${providerResult.providerReference}`}))`;
    const [vehicle, owner, operation] = await Promise.all([
      tx.vehicle.findUnique({ where: { id: claim.subject.vehicleId }, select: { id: true, ownerId: true, plateNumber: true, vin: true, status: true, isReserved: true, governmentStatus: true } }),
      tx.user.findUnique({ where: { id: claim.subject.userId }, select: { id: true, status: true, phoneStatus: true, identityStatus: true, nationalId: true } }),
      tx.operation.findUnique({ where: { id: claim.operationId } }),
    ]);
    if (!operation || operation.type !== OPERATION_TYPE || operation.idempotencyKey !== claim.idempotencyKey) throw new Error('VEHICLE_OWNERSHIP_OPERATION_NOT_FOUND');
    if (operation.status === 'SUCCESS') {
      return { result: publicResult({ decision: 'VERIFIED', vehicleId: claim.subject.vehicleId, status: 'ACTIVE', governmentStatus: 'VERIFIED', replayed: true }) };
    }
    const subjectChanged = !vehicle || !owner
      || vehicle.ownerId !== claim.subject.userId
      || vehicle.plateNumber !== claim.subject.plateNumber
      || vehicle.vin !== claim.subject.vin
      || vehicle.isReserved
      || vehicle.status === 'SOLD'
      || ['RESTRICTED', 'BLOCKED'].includes(vehicle.governmentStatus)
      || owner.status !== 'ACTIVE'
      || owner.phoneStatus !== 'VERIFIED'
      || !isIdentityVerified(owner)
      || owner.nationalId !== claim.subject.nationalId;
    if (subjectChanged) {
      await tx.operation.update({ where: { id: operation.id }, data: { status: 'MANUAL_REVIEW', metadata: { vehicleId: claim.subject.vehicleId, subjectDigest: claim.digest, providerDecision: providerResult.decision, reconciliationCode: 'OWNERSHIP_SUBJECT_CHANGED' } } });
      return { error: 'VEHICLE_OWNERSHIP_SUBJECT_CHANGED' as const };
    }
    const replay = await tx.operation.findFirst({
      where: { type: OPERATION_TYPE, providerReference: providerResult.providerReference, id: { not: operation.id } },
      select: { id: true },
    });
    if (replay || (operation.providerReference && operation.providerReference !== providerResult.providerReference)) {
      await tx.operation.update({ where: { id: operation.id }, data: { status: 'MANUAL_REVIEW', metadata: { vehicleId: vehicle.id, subjectDigest: claim.digest, providerDecision: providerResult.decision, reconciliationCode: 'PROVIDER_REFERENCE_REPLAY' } } });
      return { error: 'TRAFFIC_PROVIDER_REFERENCE_REPLAY' as const };
    }

    if (providerResult.decision === 'REJECTED') {
      await tx.operation.update({
        where: { id: operation.id },
        data: { status: 'FAILED', providerReference: providerResult.providerReference, metadata: { vehicleId: vehicle.id, subjectDigest: claim.digest, providerDecision: 'REJECTED' } },
      });
      await tx.auditLog.create({ data: { userId: params.userId, action: 'VEHICLE_OWNERSHIP_REJECTED', entityType: 'VEHICLE', entityId: vehicle.id } });
      return { result: publicResult({ decision: 'REJECTED', vehicleId: vehicle.id, status: vehicle.status, governmentStatus: vehicle.governmentStatus, replayed: false }) };
    }

    await tx.vehicle.update({ where: { id: vehicle.id }, data: { status: 'ACTIVE', governmentStatus: 'VERIFIED' } });
    await tx.vehicleOwnership.updateMany({ where: { vehicleId: vehicle.id, ownershipStatus: 'ACTIVE' }, data: { ownershipStatus: 'PREVIOUS' } });
    await tx.vehicleOwnership.create({ data: { vehicleId: vehicle.id, ownerId: params.userId, ownershipStatus: 'ACTIVE', verifiedAt: new Date() } });
    await tx.operation.update({
      where: { id: operation.id },
      data: { status: 'SUCCESS', providerReference: providerResult.providerReference, metadata: { vehicleId: vehicle.id, subjectDigest: claim.digest, providerDecision: 'VERIFIED' } },
    });
    await tx.auditLog.create({ data: { userId: params.userId, action: 'VEHICLE_OWNERSHIP_VERIFIED', entityType: 'VEHICLE', entityId: vehicle.id } });
    return { result: publicResult({ decision: 'VERIFIED', vehicleId: vehicle.id, status: 'ACTIVE', governmentStatus: 'VERIFIED', replayed: false }) };
  });
  if ('error' in finalized) throw new Error(finalized.error);
  return finalized.result;
}
