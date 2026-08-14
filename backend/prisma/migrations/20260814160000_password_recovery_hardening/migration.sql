-- Bind every new recovery request to the account session version observed at
-- issuance. Existing requests cannot be bound safely after the fact, so they
-- are invalidated and assigned an impossible sentinel before NOT NULL is set.
ALTER TABLE "PasswordResetRequest"
  ADD COLUMN "expectedSessionVersion" INTEGER;

UPDATE "PasswordResetRequest"
SET
  "expectedSessionVersion" = -1,
  "completedAt" = COALESCE("completedAt", CURRENT_TIMESTAMP);

ALTER TABLE "PasswordResetRequest"
  ALTER COLUMN "expectedSessionVersion" SET NOT NULL;
