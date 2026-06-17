---
summary: Cross-team invariants every Acme repository upholds.
freshness:
  reviewAfter: 2026-12-10
---

# System Invariants

- All money values are integer minor units paired with a currency; no floats in any money path.
- Personal data is reached through the platform data API; no service reads another team's tables directly.
- Every cross-service call carries a timeout and an idempotency key.
- Secrets never enter the repository; they load from the platform secret store at runtime.
