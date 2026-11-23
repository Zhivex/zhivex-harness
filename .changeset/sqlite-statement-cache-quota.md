---
"@zhivex-ai/harness": patch
---

Reuse prepared SQLite statements per connection and keep the session index byte quota in a trigger-maintained counter instead of scanning every session and run on each write. The counter table is additive: the session schema version is unchanged, existing databases are backfilled once on open, and older engines sharing the file keep it current through the triggers.
