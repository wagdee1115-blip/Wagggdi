import { Prisma } from '@prisma/client';
import { z } from 'zod';
import { getCurrentUser } from '@/lib/api-auth';
import { db } from '@/lib/db';
import {
  formatDateOnly,
  getIdentityProvider,
  isAdult,
  normalizeNationalId,
  parseDateOnly,
} from '@/lib/identity-provider-http';
import { isIdentityVerified } from '@/lib/identity-policy';
import { consumeCompositeRateLimit } from '@/lib/rate-limit';
import { getTrustedClientIp } from '@/lib/request-identity';

const submissionSchema = z.object({
  nationalId: z.string().trim().min(6).max(40),
  dateOfBirth: z.string().trim().regex(/^\d{4}-\d{2}-\d{2}$/),
});

function maskNationalId(value: string | null | undefined) {
  if (!value) return null;
  return value.length <= 4 ? '*'.repeat(value.length) : `${'*'.repeat(Math.min(8, value.length - 4))}${value.slice(-4)}`;
}

function publicVerification(verification: {
  id: string;
  status: string;
  provider: string;
  createdAt: Date;
  updatedAt: Date;
  verifiedAt: Date | null;
}) {
  return {
    id: verification.id,
    status: verification.status,
    provider: verification.provider,
    createdAt: verification.createdAt,
    updatedAt: verification.updatedAt,
    verifiedAt: verification.verifiedAt,
  };
}

function identitySubmissionResponse(verification: Parameters<typeof publicVerification>[0]) {
  return Response.json(
    { ok: true, verification: publicVerification(verification) },
    { status: 201, headers: { 'Cache-Control': 'no-store' } },
  );
}

async function rejectIdentitySubmission(params: {
  userId: string;
  verificationId: string;
  providerReference?: string | null;
  auditCode: 'IDENTITY_PROVIDER_REFERENCE_REPLAY' | 'IDENTITY_SUBMISSION_CONFLICT';
}) {
  const [verification] = await db.$transaction([
    db.identityVerification.update({
      where: { id: params.verificationId },
      data: {
        status: 'REJECTED',
        providerReference: params.auditCode === 'IDENTITY_PROVIDER_REFERENCE_REPLAY'
          ? null
          : params.providerReference,
      },
    }),
    db.auditLog.create({
      data: {
        userId: params.userId,
        action: 'IDENTITY_REJECTED',
        entityType: 'IDENTITY_VERIFICATION',
        entityId: params.verificationId,
        metadata: { code: params.auditCode },
      },
    }),
    db.notification.create({
      data: {
        userId: params.userId,
        type: 'SECURITY_ALERT',
        title: 'تعذر توثيق الهوية',
        message: 'لم يؤكد مزود الهوية تطابق رقم الهوية وتاريخ الميلاد. راجع البيانات أو تواصل مع الدعم.',
        priority: 'HIGH',
      },
    }),
  ]);
  return identitySubmissionResponse(verification);
}

export async function GET() {
  const user = await getCurrentUser();
  if (!user) return Response.json({ ok: false, error: 'UNAUTHORIZED' }, { status: 401 });
  const verifications = await db.identityVerification.findMany({
    where: { userId: user.id },
    orderBy: { createdAt: 'desc' },
    take: 10,
  });
  const latest = verifications[0];
  const nationalId = user.nationalId ?? latest?.nationalId ?? null;
  const dateOfBirth = user.dateOfBirth ?? latest?.dateOfBirth ?? null;
  const verified = isIdentityVerified(user);
  return Response.json({
    ok: true,
    profile: {
      identityStatus: user.identityStatus,
      phoneStatus: user.phoneStatus,
      nationalId: verified ? null : nationalId,
      nationalIdMasked: maskNationalId(nationalId),
      dateOfBirth: dateOfBirth ? formatDateOnly(dateOfBirth) : null,
      verified,
    },
    verifications: verifications.map(publicVerification),
  }, { headers: { 'Cache-Control': 'no-store' } });
}

export async function POST(req: Request) {
  try {
    const user = await getCurrentUser();
    if (!user) return Response.json({ ok: false, error: 'UNAUTHORIZED' }, { status: 401 });
    await consumeCompositeRateLimit({ scope: 'identity-verification', limit: 3, windowMs: 60 * 60 * 1000, userId: user.id, ip: getTrustedClientIp(req) });
    if (user.phoneStatus !== 'VERIFIED') return Response.json({ ok: false, error: 'PHONE_NOT_VERIFIED' }, { status: 409 });

    const parsed = submissionSchema.safeParse(await req.json());
    if (!parsed.success) return Response.json({ ok: false, error: 'INVALID_INPUT' }, { status: 400 });
    const nationalId = normalizeNationalId(parsed.data.nationalId);
    if (!/^\d{6,20}$/.test(nationalId)) return Response.json({ ok: false, error: 'INVALID_NATIONAL_ID' }, { status: 400 });
    const dateOfBirth = parseDateOnly(parsed.data.dateOfBirth);
    if (dateOfBirth < new Date(Date.UTC(1900, 0, 1)) || !isAdult(dateOfBirth)) return Response.json({ ok: false, error: 'INVALID_DATE_OF_BIRTH' }, { status: 400 });

    if (isIdentityVerified(user)) {
      const sameIdentity = user.nationalId === nationalId && user.dateOfBirth && formatDateOnly(user.dateOfBirth) === parsed.data.dateOfBirth;
      return Response.json({ ok: false, error: sameIdentity ? 'IDENTITY_ALREADY_VERIFIED' : 'VERIFIED_IDENTITY_CHANGE_REQUIRES_SUPPORT' }, { status: 409 });
    }
    const provider = getIdentityProvider();
    const submission = await db.$transaction(async (tx) => {
      const verification = await tx.identityVerification.create({
        data: { userId: user.id, nationalId, dateOfBirth, provider: provider.name, status: 'PENDING' },
      });
      await tx.auditLog.create({
        data: { userId: user.id, action: 'IDENTITY_SUBMITTED', entityType: 'IDENTITY_VERIFICATION', entityId: verification.id, metadata: { provider: provider.name } },
      });
      return verification;
    });

    let result;
    try {
      result = await provider.verifyIdentity({ verificationId: submission.id, userId: user.id, nationalId, dateOfBirth: parsed.data.dateOfBirth });
    } catch (providerError) {
      const code = providerError instanceof Error ? providerError.message : 'IDENTITY_PROVIDER_UNAVAILABLE';
      await db.$transaction([
        db.identityVerification.update({ where: { id: submission.id }, data: { status: 'UNVERIFIED' } }),
        db.auditLog.create({ data: { userId: user.id, action: 'IDENTITY_PROVIDER_FAILED', entityType: 'IDENTITY_VERIFICATION', entityId: submission.id, metadata: { code } } }),
      ]);
      throw providerError;
    }

    if (result.providerReference) {
      const referenceOwner = await db.identityVerification.findUnique({
        where: { provider_providerReference: { provider: provider.name, providerReference: result.providerReference } },
        select: { id: true },
      });
      if (referenceOwner && referenceOwner.id !== submission.id) {
        return rejectIdentitySubmission({
          userId: user.id,
          verificationId: submission.id,
          auditCode: 'IDENTITY_PROVIDER_REFERENCE_REPLAY',
        });
      }
    }

    if (result.status !== 'VERIFIED') {
      try {
        const finalized = await db.$transaction(async (tx) => {
          const verification = await tx.identityVerification.update({
            where: { id: submission.id },
            data: { status: result.status, providerReference: result.providerReference },
          });
          await tx.auditLog.create({
            data: { userId: user.id, action: result.status === 'REJECTED' ? 'IDENTITY_REJECTED' : 'IDENTITY_PENDING', entityType: 'IDENTITY_VERIFICATION', entityId: verification.id, metadata: { provider: provider.name } },
          });
          if (result.status === 'REJECTED') {
            await tx.notification.create({
              data: { userId: user.id, type: 'SECURITY_ALERT', title: 'تعذر توثيق الهوية', message: 'لم يؤكد مزود الهوية تطابق رقم الهوية وتاريخ الميلاد. راجع البيانات أو تواصل مع الدعم.', priority: 'HIGH' },
            });
          }
          return verification;
        });
        return identitySubmissionResponse(finalized);
      } catch (error) {
        if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
          return rejectIdentitySubmission({
            userId: user.id,
            verificationId: submission.id,
            auditCode: 'IDENTITY_PROVIDER_REFERENCE_REPLAY',
          });
        }
        throw error;
      }
    }

    try {
      const finalized = await db.$transaction(async (tx) => {
        await tx.$queryRaw`SELECT id FROM "User" WHERE id = ${user.id} FOR UPDATE`;
        const current = await tx.user.findUnique({ where: { id: user.id } });
        if (!current || current.status !== 'ACTIVE') throw new Error('UNAUTHORIZED');
        if (isIdentityVerified(current) && (current.nationalId !== nationalId || !current.dateOfBirth || formatDateOnly(current.dateOfBirth) !== parsed.data.dateOfBirth)) {
          const verification = await tx.identityVerification.update({ where: { id: submission.id }, data: { status: 'REJECTED', providerReference: result.providerReference } });
          await tx.auditLog.create({ data: { userId: user.id, action: 'IDENTITY_REJECTED', entityType: 'IDENTITY_VERIFICATION', entityId: submission.id, metadata: { code: 'VERIFIED_IDENTITY_CHANGED_DURING_REQUEST' } } });
          await tx.notification.create({
            data: { userId: user.id, type: 'SECURITY_ALERT', title: 'تعذر توثيق الهوية', message: 'لم يؤكد مزود الهوية تطابق رقم الهوية وتاريخ الميلاد. راجع البيانات أو تواصل مع الدعم.', priority: 'HIGH' },
          });
          return { conflict: true as const, verification };
        }
        const duplicate = await tx.user.findFirst({ where: { nationalId, id: { not: user.id } }, select: { id: true } });
        if (duplicate) {
          const verification = await tx.identityVerification.update({ where: { id: submission.id }, data: { status: 'REJECTED', providerReference: result.providerReference } });
          await tx.auditLog.create({ data: { userId: user.id, action: 'IDENTITY_REJECTED', entityType: 'IDENTITY_VERIFICATION', entityId: submission.id, metadata: { code: 'IDENTITY_SUBMISSION_CONFLICT' } } });
          await tx.notification.create({
            data: { userId: user.id, type: 'SECURITY_ALERT', title: 'تعذر توثيق الهوية', message: 'لم يؤكد مزود الهوية تطابق رقم الهوية وتاريخ الميلاد. راجع البيانات أو تواصل مع الدعم.', priority: 'HIGH' },
          });
          return { conflict: true as const, verification };
        }

        const verifiedAt = new Date();
        const verification = await tx.identityVerification.update({
          where: { id: submission.id },
          data: { status: 'VERIFIED', providerReference: result.providerReference, verifiedAt },
        });
        await tx.user.update({
          where: { id: user.id },
          data: { nationalId, dateOfBirth, identityStatus: 'VERIFIED' },
        });
        await tx.auditLog.create({
          data: { userId: user.id, action: 'IDENTITY_VERIFIED', entityType: 'IDENTITY_VERIFICATION', entityId: verification.id, metadata: { provider: provider.name } },
        });
        await tx.notification.create({
          data: { userId: user.id, type: 'SECURITY_ALERT', title: 'تم توثيق الهوية', message: 'أكد مزود الهوية تطابق رقم الهوية وتاريخ الميلاد.', priority: 'HIGH' },
        });
        return { conflict: false as const, verification };
      });

      return identitySubmissionResponse(finalized.verification);
    } catch (error) {
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
        const referenceOwner = result.providerReference ? await db.identityVerification.findUnique({
          where: { provider_providerReference: { provider: provider.name, providerReference: result.providerReference } },
          select: { id: true },
        }) : null;
        if (referenceOwner && referenceOwner.id !== submission.id) {
          return rejectIdentitySubmission({
            userId: user.id,
            verificationId: submission.id,
            auditCode: 'IDENTITY_PROVIDER_REFERENCE_REPLAY',
          });
        }
        return rejectIdentitySubmission({
          userId: user.id,
          verificationId: submission.id,
          providerReference: result.providerReference,
          auditCode: 'IDENTITY_SUBMISSION_CONFLICT',
        });
      }
      throw error;
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : 'IDENTITY_VERIFICATION_FAILED';
    const status = message === 'UNAUTHORIZED' ? 401
      : message === 'RATE_LIMITED' ? 429
        : message.startsWith('NOT_CONFIGURED') ? 503
          : ['IDENTITY_PROVIDER_UNAVAILABLE', 'IDENTITY_PROVIDER_RESPONSE_INVALID', 'IDENTITY_PROVIDER_SUBJECT_MISMATCH'].includes(message) ? 502
            : 400;
    const allowed = new Set([
      'UNAUTHORIZED', 'RATE_LIMITED', 'INVALID_INPUT', 'INVALID_NATIONAL_ID', 'INVALID_DATE_OF_BIRTH',
      'PHONE_NOT_VERIFIED',
      'IDENTITY_PROVIDER_UNAVAILABLE', 'IDENTITY_PROVIDER_RESPONSE_INVALID', 'IDENTITY_PROVIDER_SUBJECT_MISMATCH',
    ]);
    return Response.json({ ok: false, error: allowed.has(message) || message.startsWith('NOT_CONFIGURED') ? message : 'IDENTITY_VERIFICATION_FAILED' }, { status });
  }
}
