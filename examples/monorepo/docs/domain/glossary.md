---
summary: What invoice, credit note, and settlement mean at Acme.
---

# Glossary

- **Invoice**: a request for payment issued to a customer account. Immutable once sent; corrections happen by credit note, never by edit.
- **Credit note**: the only mechanism for reducing an issued invoice's amount.
- **Settlement**: the matching of incoming funds to open invoices. Settlement is eventually consistent; the ledger is the source of truth.
