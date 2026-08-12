/**
 * Legacy compatibility shim.
 * The old in-memory VehicleSaleService has been removed from all real flows.
 * Production sale state lives in PostgreSQL through transfer-workflow.ts.
 */
export { createOwnershipTransfer, advanceSaleStatus, confirmSalePayment, confirmOwnershipTransfer, confirmHandover, releasePayout } from './transfer-workflow';
export const LEGACY_VEHICLE_SALE_SERVICE = 'REMOVED_USE_POSTGRESQL_TRANSFER_WORKFLOW';
