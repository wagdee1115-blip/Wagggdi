-- DropForeignKey
ALTER TABLE "PaymentReceipt" DROP CONSTRAINT "PaymentReceipt_vehicleSaleId_fkey";

-- DropForeignKey
ALTER TABLE "SaleAuditLog" DROP CONSTRAINT "SaleAuditLog_vehicleSaleId_fkey";

-- DropForeignKey
ALTER TABLE "SaleContract" DROP CONSTRAINT "SaleContract_vehicleSaleId_fkey";

-- DropForeignKey
ALTER TABLE "SalePayment" DROP CONSTRAINT "SalePayment_vehicleSaleId_fkey";

-- AddForeignKey
ALTER TABLE "SalePayment" ADD CONSTRAINT "SalePayment_vehicleSaleId_fkey" FOREIGN KEY ("vehicleSaleId") REFERENCES "VehicleSale"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PaymentReceipt" ADD CONSTRAINT "PaymentReceipt_vehicleSaleId_fkey" FOREIGN KEY ("vehicleSaleId") REFERENCES "VehicleSale"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SaleAuditLog" ADD CONSTRAINT "SaleAuditLog_vehicleSaleId_fkey" FOREIGN KEY ("vehicleSaleId") REFERENCES "VehicleSale"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SaleContract" ADD CONSTRAINT "SaleContract_vehicleSaleId_fkey" FOREIGN KEY ("vehicleSaleId") REFERENCES "VehicleSale"("id") ON DELETE CASCADE ON UPDATE CASCADE;

