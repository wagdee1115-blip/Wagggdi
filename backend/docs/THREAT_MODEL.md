# Threat Model

Threats covered: account takeover, OTP brute force/replay, session theft, IDOR, CSRF, XSS, payment replay, double payment, double sale, double payout, fake listings, auction manipulation, payout-account hijacking, insider abuse, data leakage, API abuse/scraping, and malicious file uploads.

Controls: hashed OTPs, HttpOnly/Secure/SameSite cookies, server-side authorization, validation, rate limiting, idempotency keys, database transactions/locks, append-only audit records, private object storage, masked support data, provider signature verification, and manual review for high-risk operations.
