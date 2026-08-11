# Production Readiness

Status is not inferred from a successful build. A feature is `IMPLEMENTED` only when connected, tested and verified. UI-only features are `UI_ONLY`; missing external providers are `NOT_CONFIGURED`; test adapters are `MOCK`; future features are `FUTURE`.

Current critical external dependencies: SMS provider, payment/escrow provider, official traffic/government API, identity/KYC provider, and production object storage. These must be configured and verified before claiming end-to-end production readiness.
