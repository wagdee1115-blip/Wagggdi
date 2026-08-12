ALTER TABLE "PasswordResetRequest" ADD COLUMN "recoveryTokenHash" TEXT;
UPDATE "PasswordResetRequest" SET "recoveryTokenHash" = md5("id" || ':' || "operationId") || md5("operationId" || ':' || "id");
ALTER TABLE "PasswordResetRequest" ALTER COLUMN "recoveryTokenHash" SET NOT NULL;
CREATE UNIQUE INDEX "PasswordResetRequest_recoveryTokenHash_key" ON "PasswordResetRequest"("recoveryTokenHash");
