# Security

- Never commit `.env`, keys, passwords, OTPs or provider secrets.
- Sessions use HttpOnly/Secure/SameSite cookies.
- Browsing session target is 30 minutes; sensitive step-up session target is 2 minutes.
- OTP is 4 digits, hashed at rest, 5 minutes, 5 attempts, one-time use.
- Financial/webhook actions require idempotency.
- Prevent IDOR with server-side ownership checks.
- Use security headers including CSP/HSTS/X-Content-Type-Options/Referrer-Policy/frame protection.
- Sensitive support/KYC data is masked and access is audited.

## Round 2 security hardening

- Authorization now separates owner consent and authorized-party acceptance.
- Sensitive payout requires a sensitive session.
- Traffic webhooks use HMAC signature verification.
- Listing creation checks legal ownership or active authorization to prevent cross-user vehicle listing IDOR.
- Support uploads use MIME allowlist, magic-byte checks, SHA-256, malware-scan gating and production storage gating.
- OTP send/verify uses PostgreSQL advisory transaction locks to prevent concurrent OTP races.
