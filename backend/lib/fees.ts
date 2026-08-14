export const FEES = Object.freeze({
  // The approved ownership-transfer price is USD 80 total, inclusive.
  // Keep PLATFORM_USD at zero so no second USD 20 charge is layered on top.
  PLATFORM_USD: 0,
  DIRECT_MARKET_LISTING_COMMISSION_USD: 0,
  EXHIBITION_LISTING_SALES_COMMISSION_USD: 100,
  TRANSFER_USD: 80,
  AUCTION_PERCENT: 2.5,
  TAX_PERCENT: 0,
});

export type ListingFeeContext = 'DIRECT_MARKET' | 'EXHIBITION' | 'AUCTION';

export function calculateListingCommissionUsd(context: ListingFeeContext, soldThroughApplicableService: boolean) {
  return context === 'EXHIBITION' && soldThroughApplicableService
    ? FEES.EXHIBITION_LISTING_SALES_COMMISSION_USD
    : 0;
}

export function calculateAuctionFeeYer(finalSalePriceYer: number) {
  if (!Number.isFinite(finalSalePriceYer) || finalSalePriceYer < 0) throw new Error('INVALID_SALE_PRICE');
  return finalSalePriceYer * FEES.AUCTION_PERCENT / 100;
}
