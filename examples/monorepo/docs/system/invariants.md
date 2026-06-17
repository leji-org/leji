---
summary: Money handling, ledger append-only rule, service boundaries.
freshness:
  reviewAfter: 2026-12-10
---

# System Invariants

- All money values are integer minor units; no floats anywhere in the money path.
- The ledger is append-only; balances are derived, never stored as mutable state.
- Services communicate through events; no service reads another service's tables.
- Every external call has a timeout and an idempotency key.
