# API Contracts

Every endpoint must define authentication, authorization, validation, errors, rate limits and idempotency where state changes or money are involved. Client-supplied role/sellerId/buyerId/price is not trusted without server verification.

Current core routes include authentication, vehicles, notifications, support, auctions/bids, transfers and health. External integrations are explicitly reported as NOT_CONFIGURED when absent.
