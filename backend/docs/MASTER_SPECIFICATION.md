# MARKABAT Master Specification — V4 Final

This repository is an existing MARKABAT implementation. The governing rule is audit → diagnose → fix → complete → integrate → test → harden. Correct existing features are preserved. External integrations are never represented as successful when they are not configured.

## Locked commercial rules
- Direct market sale: listing commission 0 USD.
- Exhibition/dealer service: listing sales commission 100 USD only when that service applies and the sale is completed through it.
- Transfer service: 80 USD.
- Auction: 2.5% of final sale price.
- Government fees: provider data only; currently none.
- Tax: not applied currently.
- Exchange-rate default: 535 YER/USD, configurable and snapshotted per transaction.
- Direct sale expiry: 2 hours.
- OTP: 4 digits, 5 minutes, 5 attempts, resend cooldown 60 seconds.
- Sensitive session: 2 minutes; browsing session: 30 minutes.
- Payout protection: 15 minutes.
- Auction anti-sniping: 120 seconds, extension 120 seconds.

## Source of truth
Server/database/provider-authoritative state only. Browser state and localStorage are never financial or transactional truth.

## Integration truth
Government, payment, SMS, storage and identity providers return `NOT_CONFIGURED` until a real configured adapter exists.
