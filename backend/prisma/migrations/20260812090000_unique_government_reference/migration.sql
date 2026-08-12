-- A traffic-provider event must never be accepted for more than one sale.
CREATE UNIQUE INDEX "VehicleSale_governmentReference_key" ON "VehicleSale"("governmentReference");
