-- Provider confirmations are security boundaries. Fail before creating the
-- indexes if historical duplicates exist so deployment cannot silently bind a
-- single external confirmation to multiple local records.
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM "IdentityVerification"
    WHERE "providerReference" IS NOT NULL
    GROUP BY "provider", "providerReference"
    HAVING COUNT(*) > 1
  ) THEN
    RAISE EXCEPTION 'duplicate identity provider references require manual reconciliation';
  END IF;

  IF EXISTS (
    SELECT 1 FROM "AuctionBidDeposit"
    WHERE "providerReference" IS NOT NULL
    GROUP BY "providerReference"
    HAVING COUNT(*) > 1
  ) THEN
    RAISE EXCEPTION 'duplicate auction deposit provider references require manual reconciliation';
  END IF;

  IF EXISTS (
    SELECT 1 FROM "PayoutAccount"
    WHERE "providerReference" IS NOT NULL
    GROUP BY "providerReference"
    HAVING COUNT(*) > 1
  ) THEN
    RAISE EXCEPTION 'duplicate payout provider references require manual reconciliation';
  END IF;

  IF EXISTS (
    SELECT 1 FROM "SaleAuditLog"
    WHERE action = 'PAYOUT_CONFIRMED' AND reference IS NOT NULL
    GROUP BY reference
    HAVING COUNT(DISTINCT "vehicleSaleId") > 1
  ) THEN
    RAISE EXCEPTION 'duplicate sale payout provider references require manual reconciliation';
  END IF;
END $$;

CREATE UNIQUE INDEX "IdentityVerification_provider_providerReference_key"
  ON "IdentityVerification"("provider", "providerReference");

CREATE UNIQUE INDEX "AuctionBidDeposit_providerReference_key"
  ON "AuctionBidDeposit"("providerReference");

CREATE UNIQUE INDEX "PayoutAccount_providerReference_key"
  ON "PayoutAccount"("providerReference");

ALTER TABLE "VehicleSale" ADD COLUMN "payoutProviderReference" TEXT;

UPDATE "VehicleSale" sale
SET "payoutProviderReference" = payout.reference
FROM (
  SELECT DISTINCT ON ("vehicleSaleId") "vehicleSaleId", reference
  FROM "SaleAuditLog"
  WHERE action = 'PAYOUT_CONFIRMED' AND reference IS NOT NULL
  ORDER BY "vehicleSaleId", "createdAt" DESC
) payout
WHERE payout."vehicleSaleId" = sale.id;

CREATE UNIQUE INDEX "VehicleSale_payoutProviderReference_key"
  ON "VehicleSale"("payoutProviderReference");
