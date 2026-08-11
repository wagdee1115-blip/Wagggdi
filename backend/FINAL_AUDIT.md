> ROUND 2 STATUS OVERRIDE: Static implementation statements in this legacy audit are not runtime proof. See `docs/FINAL_VERIFICATION_REPORT.md` for the authoritative evidence status.

# MARKABAT V4 — Final Hardening Audit (2026-08-11)

## Execution scope
Hardening الجولة النهائية على النسخة الحالية فقط. لا مشروع بديل ولا حذف للوظائف الصحيحة.

## Status key
- COMPLETED: implemented in repository and statically reviewed.
- PARTIAL: core implementation exists but end-to-end proof requires configured infrastructure or further UI wiring.
- NOT_CONFIGURED: requires an external provider/service and must not be faked.
- BLOCKED: verification could not be completed in this environment.

## 1. Auctions
- PostgreSQL source of truth: **COMPLETED** — bids/auctions/auto-bids/deposits are Prisma models; auction bid path uses a PostgreSQL row lock.
- Anti-sniping 120s -> +120s: **COMPLETED** in service logic.
- Auto-bid: **COMPLETED** in server-side proxy bidding logic and API.
- Bid deposit: **PARTIAL / NOT_CONFIGURED** — schema and hold API exist; real deposit hold requires `AUCTION_DEPOSIT_PROVIDER_URL` + secret.
- Idempotency: **COMPLETED** — `Idempotency-Key` and unique DB key.
- Winner lock: **COMPLETED** — conditional winner claim plus row lock.
- Winner -> real Sale: **COMPLETED** in auction finalization service; sale is PostgreSQL-backed with a 2-hour payment deadline.
- Auction -> payment -> escrow -> transfer -> handover -> payout: **PARTIAL** — state/data flow exists, but external payment/escrow/traffic/payout providers are not configured.

## 2. OTP
- DB instead of memory Map: **COMPLETED**.
- 4 digits: **COMPLETED**.
- 5 minutes: **COMPLETED**.
- 5 attempts: **COMPLETED**.
- resend after 60 seconds: **COMPLETED**.
- phone/IP/device rate limits: **COMPLETED** at DB level.
- testOtp removed from API: **COMPLETED**.
- OTP never returned in API response: **COMPLETED**.
- Real SMS delivery: **NOT_CONFIGURED — External Provider Required**.

## 3. Direct sale
- 2-hour expiry: **COMPLETED** in server state and expiry job.
- Vehicle lock: **COMPLETED** using PostgreSQL atomic update.
- Buyer mapping by phone -> buyerId: **COMPLETED** in create-transfer API.
- Payment confirmation: **PARTIAL / NOT_CONFIGURED — External Payment Provider Required**.
- Escrow: **NOT_CONFIGURED — External Escrow Provider Required**.
- Government ownership transfer: **NOT_CONFIGURED — Government API Required**.
- Handover: **COMPLETED** at DB/API layer; provider-backed ownership transfer is still required first.
- 15-minute payout protection: **COMPLETED** as configurable state/timer.
- Payout: **NOT_CONFIGURED — Payout Provider Required**.
- Dispute/manual review: **COMPLETED** at DB/API layer.

## 4. Ledger
- Double-entry model: **COMPLETED**.
- Customer funds -> escrow: **COMPLETED** in payment confirmation path.
- Transfer fee 80 USD: **COMPLETED**.
- Exhibition commission 100 USD only when applicable: **COMPLETED**.
- Auction fee 2.5%: **COMPLETED**.
- Government fees separate: **COMPLETED**.
- Refund category: **COMPLETED** in schema.
- Double payment/payout protection: **PARTIAL** — DB locks/idempotency are implemented; provider-side idempotency must also be configured.
- Old fee test corrected: **COMPLETED**.

## 5. Authorization
- SELL_ONLY: **COMPLETED** in authorization model and sale authority resolution.
- SELL_AND_RECEIVE: **COMPLETED** in model and payout-user selection.
- Owner consent: **COMPLETED** in creation/activation path.
- Delegate acceptance: **COMPLETED** in API path.
- SMS OTP: **PARTIAL / NOT_CONFIGURED — SMS Provider Required**.
- PDF: **PARTIAL / NOT_CONFIGURED — Document Storage/PDF Provider Required**.
- QR payload: **COMPLETED**.
- SHA-256: **COMPLETED**.
- Expiry/revoke: **COMPLETED** with cron expiry.
- Name matching: **PARTIAL** — payout account model contains verification/name-match state; external provider verification is still required.
- Sub-delegation: **COMPLETED** by owner-only authorization creation and no delegation relation.

## 6. Notifications/support
- In-app notification persistence: **COMPLETED**.
- Event notifications for transfer/payment/ownership/handover/payout: **COMPLETED** at API/event boundaries.
- Support IDOR: **COMPLETED** for user ticket access.
- Staff support masking: **COMPLETED** for staff lookup endpoint.
- Attachments allowlist/hash/size: **COMPLETED** at API layer.
- Attachment storage: **NOT_CONFIGURED — Storage Provider Required**.
- SMS notifications: **NOT_CONFIGURED — SMS Provider Required**.

## 7. Security
- API authentication/authorization: **COMPLETED** in audited routes.
- CSRF origin guard: **COMPLETED** via middleware for API mutations, with provider/cron exceptions.
- XSS: **PARTIAL** — validation and output constraints exist; a full browser security scan was not executable here.
- Rate limiting: **COMPLETED** for login/auction/OTP paths; broader WAF remains deployment-level.
- Session cookie security: **COMPLETED** — HttpOnly/Secure production/SameSite; 30-minute browsing JWT and 2-minute sensitive JWT.
- Secrets: **COMPLETED** — provider secrets moved to environment configuration; no real secrets included.
- Audit: **COMPLETED** at sale/security data layer.
- Upload security: **PARTIAL** — MIME/size/hash allowlists exist; malware scanner is **NOT_CONFIGURED — External Service Required**.

## 8. Tests
- Unit tests: **COMPLETED** for fee/OTP/auction rules.
- Financial integration tests: **BLOCKED** — no PostgreSQL dependency installation/connection in this environment.
- Concurrent PostgreSQL tests: **BLOCKED** for same reason.
- E2E: **BLOCKED / NOT_CONFIGURED** — requires PostgreSQL + real providers.
- Security browser tests: **BLOCKED** — dependencies/browser environment unavailable.

## 9. Build/Vercel
- Prisma schema/code changes: **COMPLETED** in source.
- `npm install`: **BLOCKED** — package installation timed out twice in this environment.
- `prisma generate`: **BLOCKED** — Prisma CLI could not be installed/executed after the dependency timeout.
- Typecheck: **BLOCKED** as a complete project check because dependencies are unavailable. Static parse check found no TypeScript parser errors in the final edited source.
- Production build: **BLOCKED** — dependencies unavailable.
- PWA manifest/service worker: **COMPLETED** in backend public assets; API routes are explicitly excluded from caching.
- Vercel cron jobs: **COMPLETED** in `vercel.json`.
- Environment variables: **DOCUMENTED** in `.env.example`.

## External provider rule
The following are intentionally not faked:
- SMS — NOT_CONFIGURED — External Provider Required
- Payment — NOT_CONFIGURED — External Provider Required
- Escrow — NOT_CONFIGURED — External Provider / legal arrangement Required
- Traffic — NOT_CONFIGURED — Government API Required
- KYC — NOT_CONFIGURED — Identity Provider Required
- Storage/CDN — NOT_CONFIGURED — Production Storage Required
- Malware scanner — NOT_CONFIGURED — External Service Required
- Vercel build — BLOCKED until dependencies can be installed and the build can actually run

## Final conclusion
This repository is a substantially hardened pre-production build. It is **not honestly claimable as fully Production Ready** until PostgreSQL and the external providers are configured and the complete test/build pipeline is executed successfully.
