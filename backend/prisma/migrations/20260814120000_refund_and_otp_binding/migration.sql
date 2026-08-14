-- Explicit, provider-backed refund lifecycle for captured sale payments.
ALTER TYPE "SaleStatus" ADD VALUE IF NOT EXISTS 'REFUND_PENDING';
ALTER TYPE "SaleStatus" ADD VALUE IF NOT EXISTS 'REFUND_PROCESSING';
ALTER TYPE "SaleStatus" ADD VALUE IF NOT EXISTS 'REFUNDED';
ALTER TYPE "SaleStatus" ADD VALUE IF NOT EXISTS 'REFUND_FAILED';

ALTER TABLE "VehicleSale"
  ADD COLUMN "refundProviderReference" TEXT,
  ADD COLUMN "refundIdempotencyKey" TEXT,
  ADD COLUMN "refundReason" TEXT,
  ADD COLUMN "refundFailureReason" TEXT,
  ADD COLUMN "refundProcessingAt" TIMESTAMP(3),
  ADD COLUMN "refundedAt" TIMESTAMP(3),
  ADD COLUMN "refundAttempts" INTEGER NOT NULL DEFAULT 0;

CREATE UNIQUE INDEX "VehicleSale_refundProviderReference_key" ON "VehicleSale"("refundProviderReference");
CREATE UNIQUE INDEX "VehicleSale_refundIdempotencyKey_key" ON "VehicleSale"("refundIdempotencyKey");
CREATE INDEX "OtpRecord_userId_createdAt_idx" ON "OtpRecord"("userId", "createdAt");
