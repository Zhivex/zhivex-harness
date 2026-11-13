# Gemini decision for Harness 1.0

Decision date: 2026-08-23

Gemini is provisional and is excluded from the Harness 1.0 GA-certified provider cohort. The certified cohort for release-candidate and GA evidence is Meta, Qwen, and OpenAI. This is an explicit support decision, not an inference from quota or upstream capacity.

The decision is enforced consistently by the provider registry, support matrix, representative-evaluation matrix, protected release workflow, and GA readiness ledger. A `429`, `503`, skipped credentialed run, or partial smoke does not establish parity and must not be presented as certification.

Promoting Gemini requires a later exact release candidate to pass the same release-bound base, orchestration, routing, model-directed OCI execution, installed-artifact, and representative-repository gates as the certified cohort. Evidence must record the exact provider, model, tag, commit, artifact integrity, OCI image digest, successful workflow run, and observation time before the registry or documentation can claim certified support.
