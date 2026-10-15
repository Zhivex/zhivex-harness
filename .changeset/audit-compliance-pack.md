---
"@zhivex-ai/harness": patch
"@zhivex-ai/code": patch
---

Add an experimental audit pack export and verify command. One signed directory contains the governance report, approval decisions, policy decisions, the redacted activity journal as JSONL, and the usage ledger. Integrity is HMAC-SHA256 with a configurable key. The stable 1.x root API is unchanged.
