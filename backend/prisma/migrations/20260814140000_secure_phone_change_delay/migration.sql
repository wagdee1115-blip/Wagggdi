-- A phone change is a delayed, revocable security operation. The raw new
-- phone is required only for provider delivery and the eventual atomic swap;
-- API and audit projections expose newPhoneMasked instead.
CREATE TYPE "PhoneChangeStatus" AS ENUM (
  'OTP_PENDING',
  'SECURITY_DELAY',
  'ACTIVATED',
  'CANCELLED',
  'EXPIRED',
  'FAILED'
);

CREATE TABLE "PhoneChangeRequest" (
  "id" TEXT NOT NULL,
  "userId" TEXT NOT NULL,
  "oldPhone" TEXT NOT NULL,
  "newPhone" TEXT NOT NULL,
  "newPhoneMasked" TEXT NOT NULL,
  "status" "PhoneChangeStatus" NOT NULL DEFAULT 'OTP_PENDING',
  "activeUserKey" TEXT,
  "reservedPhoneKey" TEXT,
  "expectedSessionVersion" INTEGER NOT NULL,
  "otpDeliveryId" TEXT NOT NULL,
  "otpHash" TEXT,
  "otpAttempts" INTEGER NOT NULL DEFAULT 0,
  "otpMaxAttempts" INTEGER NOT NULL DEFAULT 5,
  "otpExpiresAt" TIMESTAMP(3) NOT NULL,
  "resendAvailableAt" TIMESTAMP(3) NOT NULL,
  "requestExpiresAt" TIMESTAMP(3) NOT NULL,
  "otpVerifiedAt" TIMESTAMP(3),
  "activateAt" TIMESTAMP(3),
  "activatedAt" TIMESTAMP(3),
  "cancelledAt" TIMESTAMP(3),
  "expiredAt" TIMESTAMP(3),
  "provider" TEXT NOT NULL,
  "providerReference" TEXT,
  "requestIpHash" TEXT,
  "deviceHash" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,

  CONSTRAINT "PhoneChangeRequest_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "PhoneChangeRequest_activeUserKey_key" ON "PhoneChangeRequest"("activeUserKey");
CREATE UNIQUE INDEX "PhoneChangeRequest_reservedPhoneKey_key" ON "PhoneChangeRequest"("reservedPhoneKey");
CREATE UNIQUE INDEX "PhoneChangeRequest_otpDeliveryId_key" ON "PhoneChangeRequest"("otpDeliveryId");
CREATE INDEX "PhoneChangeRequest_userId_createdAt_idx" ON "PhoneChangeRequest"("userId", "createdAt");
CREATE INDEX "PhoneChangeRequest_status_activateAt_idx" ON "PhoneChangeRequest"("status", "activateAt");
CREATE INDEX "PhoneChangeRequest_requestExpiresAt_idx" ON "PhoneChangeRequest"("requestExpiresAt");
CREATE INDEX "PhoneChangeRequest_requestIpHash_createdAt_idx" ON "PhoneChangeRequest"("requestIpHash", "createdAt");
CREATE INDEX "PhoneChangeRequest_deviceHash_createdAt_idx" ON "PhoneChangeRequest"("deviceHash", "createdAt");

ALTER TABLE "PhoneChangeRequest"
  ADD CONSTRAINT "PhoneChangeRequest_userId_fkey"
  FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
