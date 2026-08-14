-- One escrow confirmation and one provider reference can secure a sale only once.
CREATE UNIQUE INDEX "EscrowTransaction_vehicleSaleId_key" ON "EscrowTransaction"("vehicleSaleId");
CREATE UNIQUE INDEX "EscrowTransaction_paymentProviderReference_key" ON "EscrowTransaction"("paymentProviderReference");

-- One bidder has one logical deposit operation per auction; retries reuse it.
CREATE UNIQUE INDEX "AuctionBidDeposit_auctionId_bidderId_key" ON "AuctionBidDeposit"("auctionId", "bidderId");
