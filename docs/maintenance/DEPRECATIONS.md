# Compatibility and deprecations

Stable `1.x` CLI commands, documented option meanings, exit codes, stable runtime exports, JSON/schema meanings, persisted-state readers, and machine error codes follow semantic versioning. Additive fields may be introduced in observational JSON schemas; signed or digest-bound documents remain strict and require a schema version change.

A planned incompatible removal receives a deprecation notice in documentation and the changelog for at least one minor release before removal in the next major release. Security fixes may tighten validation immediately when retaining the old behavior would preserve an exploitable authority path; the release must document the break and a safe migration.

Beta APIs may change in a minor release with migration notes. Experimental APIs may change or be removed without a deprecation window and must not be used as the only path to a stable operation. Release candidates are immutable artifacts but are not covered by the final `1.x` compatibility promise.

Changing a default provider/model, configuration default, execution policy, approval fingerprint, persisted schema, or redaction boundary is observable and requires changelog, migration analysis, installed-consumer tests, and any applicable live recertification.
