export const FEES = Object.freeze({
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
