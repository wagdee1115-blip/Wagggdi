# Data Classification

## Public
Vehicle listing fields, public listing images, listing price.

## Private
Phone, optional email, messages, transaction metadata.

## Sensitive
Identity/KYC, payout account details, financial data.

## Restricted
Secrets, OTP hashes, provider keys, security credentials.

Restricted data must never be emitted to frontend responses or ordinary logs.
