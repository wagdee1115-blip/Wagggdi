# MARKABAT V4 — Hardening Round 2 Changelog

## Goal
Correct and complete the current V4 Hardened project without rebuilding it.

## Key changes
- Canonical sale state machine and transition guard.
- Exact 2-hour sale expiration.
- PostgreSQL vehicle reservation guard by `vehicleId`.
- SELL_ONLY / SELL_AND_RECEIVE payout authority hardening.
- Owner consent + authorized-party acceptance for authorization.
- OTP DB storage, advisory locking, 4 digits, 5 minutes, 5 attempts, 60-second resend.
- Password reset session invalidation and audit/notification.
- Double-entry ledger advisory lock and balance assertion.
- Payment amount verification in signed webhook.
- Auction deposit ledgering, application/refund/forfeit provider flows.
- Listing authorization/IDOR fix.
- Support upload security and malware scan gate.
- Traffic webhook HMAC verification.
- Sensitive session requirement for payout.
- Updated stale 80 USD wording to 80 USD transfer fee.
- Added real concurrency/state-machine/financial test coverage where environment permits.

## Not claimed as complete
No runtime PostgreSQL, npm dependency install, production build, browser E2E, or external-provider success is claimed from this environment.
