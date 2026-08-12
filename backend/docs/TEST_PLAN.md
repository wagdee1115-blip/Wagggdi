# Test Plan

Authentication: login by phone, OTP expiry, wrong OTP, five-attempt lock, replay, recovery.

Vehicles: listing CRUD, image validation/hash, search/filtering.

Direct sale: buyer approval, payment webhook, escrow, 2-hour expiry, vehicle lock, handover, payout protection, dispute.

Authorization: SELL_ONLY, SELL_AND_RECEIVE, OTP, accept/reject/revoke/expire.

Auction: minimum 50,000 YER, seller cannot bid, phone verification, concurrent bids, idempotency, anti-sniping, optional deposit and auto-bid architecture.

Security: IDOR, CSRF, XSS, rate limits, replay, unauthorized admin, secrets scanning.

PWA: manifest, service worker, install, offline fallback, no sensitive caching.
