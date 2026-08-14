-- Correct the previously ambiguous escrow reference storage and bind payments to sales.
-- Existing EscrowTransaction.paymentProviderReference values were written by the
-- Wave 1 code as escrow-provider references, so preserve them under the correct name.
ALTER TABLE "EscrowTransaction" RENAME COLUMN "paymentProviderReference" TO "escrowProviderReference";
ALTER INDEX "EscrowTransaction_paymentProviderReference_key" RENAME TO "EscrowTransaction_escrowProviderReference_key";
ALTER TABLE "EscrowTransaction" ADD COLUMN "paymentProviderReference" TEXT;
ALTER TABLE "PaymentTransaction" ADD COLUMN "vehicleSaleId" TEXT;

-- Backfill rows written by Wave 1 from the atomic sale audit evidence. Ambiguous
-- or absent evidence intentionally remains NULL and therefore fails closed.
UPDATE "EscrowTransaction" escrow
SET "paymentProviderReference" = audit.metadata->>'paymentProviderReference'
FROM "SaleAuditLog" audit
WHERE audit."vehicleSaleId" = escrow."vehicleSaleId"
  AND audit.action = 'ESCROW_HELD'
  AND audit.metadata->>'paymentProviderReference' IS NOT NULL;

UPDATE "PaymentTransaction" payment
SET "vehicleSaleId" = audit."vehicleSaleId"
FROM "SaleAuditLog" audit
WHERE audit.action = 'PAYMENT_CONFIRMED'
  AND audit.reference = payment."providerReference";

-- Abort rather than silently accepting duplicate bindings before adding constraints.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM "EscrowTransaction" WHERE "paymentProviderReference" IS NOT NULL GROUP BY "paymentProviderReference" HAVING COUNT(*) > 1) THEN
    RAISE EXCEPTION 'duplicate EscrowTransaction payment provider references';
  END IF;
  IF EXISTS (SELECT 1 FROM "PaymentTransaction" WHERE "vehicleSaleId" IS NOT NULL GROUP BY "vehicleSaleId" HAVING COUNT(*) > 1) THEN
    RAISE EXCEPTION 'duplicate PaymentTransaction vehicle sale bindings';
  END IF;
END $$;

CREATE UNIQUE INDEX "EscrowTransaction_paymentProviderReference_key" ON "EscrowTransaction"("paymentProviderReference");
CREATE UNIQUE INDEX "PaymentTransaction_vehicleSaleId_key" ON "PaymentTransaction"("vehicleSaleId");
ALTER TABLE "PaymentTransaction" ADD CONSTRAINT "PaymentTransaction_vehicleSaleId_fkey" FOREIGN KEY ("vehicleSaleId") REFERENCES "VehicleSale"("id") ON DELETE SET NULL ON UPDATE CASCADE;
