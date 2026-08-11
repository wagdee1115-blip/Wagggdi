# MARKABAT V4 — FINAL VERIFICATION REPORT

## Round
HARDENING ROUND 2 — Audit → Correct → Complete → Integrate → Test → Verify

## Verification date
2026-08-11

## Important status rule
This report does **not** treat code written without execution evidence as PASS.

Allowed statuses:
- PASS
- FAIL
- BLOCKED
- NOT_CONFIGURED

## Executive result
The current package contains substantial hardening and correction work, but it is **not yet Production Ready** because the final runtime environment could not be provisioned in this verification environment.

### Current Production Readiness: **52%**

Scoring basis:
- Static/source audit and implementation evidence: 32/40
- Local syntax/schema consistency checks: 20/20
- PostgreSQL/runtime verification: 0/20 (environment unavailable)
- Real external providers: 0/20 (not configured)

The percentage is intentionally conservative. It is not a claim that 52% of the features are coded; it reflects production-readiness evidence available at this round.

## Test matrix

| Test / Gate | Status | Reason / Evidence |
|---|---|---|
| Prisma model/enum duplicate scan | PASS | 56 models, 32 enums, no duplicate model/enum names detected |
| Prisma index/unique field consistency scan | PASS | No index/unique references to missing model fields detected |
| TypeScript syntax transpilation of Round-2 critical files | PASS | 11 critical files transpiled without syntax diagnostics |
| `testOtp` / `devCode` scan | PASS | No occurrences in source |
| Core `describe.skip` / `it.skip` / `test.skip` scan | PASS | No skipped tests found |
| Sensitive-operation Memory Map scan | PASS | No Map/Set source-of-truth use found in Payment/Escrow/Auction/OTP/Sale/Payout/Authorization/Vehicle Lock |
| Direct Sale state-machine implementation | PASS | Canonical states and server-side transition guard implemented; unit tests added |
| Direct Sale PostgreSQL concurrency | BLOCKED | PostgreSQL DATABASE_URL/dependencies unavailable in this environment |
| Vehicle lock concurrency | BLOCKED | Requires live PostgreSQL |
| Auction concurrent bid | BLOCKED | Requires live PostgreSQL |
| Auction winner lock | BLOCKED | Requires live PostgreSQL |
| Auto-bid runtime | BLOCKED | Requires live PostgreSQL |
| Bid deposit runtime | NOT_CONFIGURED | Real deposit provider not configured |
| OTP DB runtime | BLOCKED | Requires PostgreSQL and dependencies |
| OTP 4/5/60 rules | PASS | Source + unit-test contract verified |
| Password recovery runtime | BLOCKED | Requires PostgreSQL + SMS provider for full flow |
| Double-entry ledger concurrency | BLOCKED | Test implemented; live PostgreSQL unavailable |
| Double payment runtime | BLOCKED | Test implemented; live PostgreSQL unavailable |
| Double payout runtime | NOT_CONFIGURED | Real payout provider required |
| Handover OTP/QR runtime | BLOCKED | Requires PostgreSQL + OTP provider/test DB |
| Authorization owner consent / authorized-party acceptance | PASS | Server-side flow implemented; runtime not yet proven |
| Authorization PDF | NOT_CONFIGURED | Authorization document storage/PDF provider required |
| Vehicle media | NOT_CONFIGURED | Storage + malware scanner + plate-redaction providers required for production |
| AI vehicle description | NOT_CONFIGURED | AI description provider not configured |
| Chat / comments authorization | PASS | Server-side ownership/participant checks present; runtime security test blocked |
| Buyer source tracking | PASS | DB-backed ListingView with source allowlist and hashed device/session identifiers |
| Price history | PASS | DB-backed VehiclePriceHistory integrated into listing create/update |
| Support attachment validation | PASS | MIME allowlist, magic bytes, SHA-256, malware scan gate, storage gate |
| Security runtime tests | BLOCKED | Dependencies/PostgreSQL unavailable |
| `npm ci` | BLOCKED | No package-lock.json exists and registry access was unavailable |
| `prisma generate` | BLOCKED | Dependencies/Prisma CLI not installed in verification environment |
| `prisma migrate deploy` | BLOCKED | PostgreSQL/dependencies unavailable |
| `npm run typecheck` | BLOCKED | Dependencies are not installed; raw global tsc only exposed missing module dependencies and legacy type issues |
| `npm test` | BLOCKED | Vitest/dependencies unavailable |
| `npm run build` | BLOCKED | Dependencies unavailable; not claimed as PASS |
| `npm start` | BLOCKED | Production build was not available |
| PWA static safety review | PASS | Service worker bypasses `/api/`; no OTP/password/payment/identity data cached by the worker |
| PWA runtime offline/reconnect | BLOCKED | Browser runtime verification not available |

## External provider status

| Provider | Status |
|---|---|
| SMS | NOT_CONFIGURED — External Provider Required |
| Payment | NOT_CONFIGURED — External Provider Required |
| Escrow | NOT_CONFIGURED — External Provider Required |
| Traffic/Government | NOT_CONFIGURED — External Provider Required |
| KYC / Face / Liveness | NOT_CONFIGURED — External Provider Required |
| Storage/CDN | NOT_CONFIGURED — Production Storage Required |
| Malware Scanner | NOT_CONFIGURED — External Service Required |
| Plate Redaction | NOT_CONFIGURED — External Service Required |
| AI Vehicle Description | NOT_CONFIGURED — External Provider Required |
| Payout / Bank | NOT_CONFIGURED — External Provider Required |

## Major corrections in Round 2

1. Added canonical direct-sale states:
   `SALE_CREATED → BUYER_PENDING → BUYER_ACCEPTED → PAYMENT_PROCESSING → PAYMENT_CONFIRMED → ESCROW_HELD → TRANSFER_PENDING → TRANSFER_IN_PROGRESS → OWNERSHIP_TRANSFERRED → HANDOVER_PENDING → HANDOVER_CONFIRMED → PAYOUT_PROTECTION → PAYOUT_PENDING → PAYOUT_PROCESSING → PAYOUT_CONFIRMED → COMPLETED`.
2. Added explicit `PAYOUT_REVIEW_REQUIRED` and `FAILED` states.
3. Direct sale expiration is exactly 2 hours from server time.
4. Vehicle reservation is guarded atomically by `vehicleId` in PostgreSQL.
5. SELL_ONLY payout target remains the legal owner.
6. SELL_AND_RECEIVE now requires a verified payout account and successful name match.
7. Authorization flow now separates owner consent from authorized-party acceptance.
8. Authorization records now store owner consent/OTP timestamps.
9. OTP now uses PostgreSQL records and PostgreSQL advisory locks for concurrent send/verify operations.
10. OTP provider can be backed by a real configured HTTP SMS provider; otherwise it returns `NOT_CONFIGURED:SMS_PROVIDER_REQUIRED`.
11. Password reset invalidates sessions through `sessionVersion`, records an audit event, and creates a security notification.
12. Handover now performs OTP verification server-side exactly once, validates QR, mileage, and records evidence.
13. Payout checks the current verified payout account and name-match state before processing.
14. Double-entry ledger now uses PostgreSQL advisory transaction locks to serialize concurrent entry-group writers.
15. Direct-market listing commission is enforced as zero; exhibition commission is only calculated when the exhibition service is explicitly selected.
16. Auction fee is only accepted for auction sales.
17. Listing creation now checks legal ownership or an active authorization, closing an IDOR/business-authorization gap.
18. Support uploads now require storage configuration and malware scanning in addition to MIME/magic-byte/SHA-256 validation.
19. Traffic webhook now requires an HMAC signature instead of a static shared header.
20. Sensitive payout API requires a sensitive session in addition to normal authorization.

## Known remaining blockers

### Environment / CI
A real `package-lock.json` could not be generated because npm registry access was unavailable. `npm ci` therefore cannot be honestly marked PASS.

### PostgreSQL
The critical concurrency, ledger, OTP, sale, auction and idempotency tests are implemented but require a live PostgreSQL instance and installed dependencies.

### External providers
No external provider was fabricated. All unconfigured services remain explicitly blocked/not configured.

### Before Production Candidate
The following must still be proven in a real environment:
1. `npm ci`
2. `npx prisma generate`
3. `npx prisma migrate deploy`
4. `npm run typecheck`
5. `npm test`
6. PostgreSQL concurrency suite
7. `npm run build`
8. `npm start`
9. Browser/PWA runtime verification
10. Real provider contract tests

## Files modified in this round

- `backend/prisma/schema.prisma`
- `backend/lib/transfer-workflow.ts`
- `backend/lib/ledger.ts`
- `backend/lib/otp.ts`
- `backend/lib/authorization.ts`
- `backend/lib/authorization-document.ts`
- `backend/lib/password-recovery.ts`
- `backend/lib/rate-limit.ts`
- `backend/app/api/auth/login/route.ts`
- `backend/app/api/authorizations/[id]/accept/route.ts`
- `backend/app/api/authorizations/[id]/owner-consent/route.ts`
- `backend/app/api/transfers/route.ts`
- `backend/app/api/transfers/[id]/route.ts`
- `backend/app/api/transfers/[id]/handover/route.ts`
- `backend/app/api/transfers/[id]/ownership-transfer/route.ts`
- `backend/app/api/transfers/[id]/payout/route.ts`
- `backend/app/api/cron/sales/expire/route.ts`
- `backend/app/api/auctions/[id]/bids/route.ts`
- `backend/app/api/auctions/[id]/auto-bid/route.ts`
- `backend/app/api/listings/route.ts`
- `backend/app/api/listings/[id]/comments/route.ts`
- `backend/app/api/support/[id]/attachments/route.ts`
- `backend/app/api/support/route.ts`
- `backend/app/traffic/ownership-transfer/page.tsx`
- `backend/tests/financial.test.ts`
- `backend/tests/state-machine.test.ts`
- `backend/lib/renewal.ts`
- `backend/lib/violations.ts`
- `backend/.env.example`

## Final decision
**NOT Production Ready.**

The package is a hardened pre-production candidate with significant corrections, but the final runtime evidence gate is still open. No external provider success is claimed.
