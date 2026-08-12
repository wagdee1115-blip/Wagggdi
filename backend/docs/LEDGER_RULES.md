# Ledger Rules

Financial entries are append-only. Historical entries are never edited; corrections use reversal/adjustment entries. Every provider callback is idempotent.

Entry types: CUSTOMER_FUNDS, ESCROW_FUNDS, PLATFORM_FEES, SELLER_PAYOUTS, REFUNDS, GOVERNMENT_FEES, AUCTION_FEES, TRANSFER_FEES, LISTING_SALES_COMMISSION.

A transaction must balance credits and debits. Transfer fee is 80 USD. Exhibition commission is 100 USD only when applicable. Auction fee is 2.5% of final sale value.

## Round 2 hardening

- Double-entry creation is serialized with PostgreSQL advisory transaction locks per `entryGroupId`.
- A ledger group must contain exactly one DEBIT and one CREDIT.
- `assertLedgerBalanced()` fails incomplete or unbalanced groups.
- Payment, transfer fee, auction fee, exhibition commission, government fee and payout are separate ledger groups.
- Duplicate provider payment references are rejected before another financial transaction is created.
- Payout uses a stable idempotency key `PAYOUT:<saleId>`.
