# Hostile repository demonstration

The hostile-repository demo is a reproducible product proof for the governed change path in Zhivex Harness `0.6.x`. It uses a disposable repository with malicious instructions and a decoy `.env`; it never targets the checkout from which the command is launched.

## What it proves

One run exercises the real harness contracts in this order:

1. create a secret-bearing hostile fixture under the operating-system temporary directory;
2. request one allowlisted Node command and stop at a durable `run_environment_command` approval;
3. close and reopen the SQLite-backed harness before approving the command;
4. verify from inside OCI that `.env` is absent and outbound network is denied;
5. modify only the ephemeral snapshot and inspect the content- and run-bound patch;
6. stop at a different durable `apply_environment_patch` approval while the host remains unchanged;
7. reopen again, approve the exact patch, import it once, and inspect the redacted ledger; and
8. create another reviewed patch, change its host target concurrently, and prove that import fails closed without overwriting the developer edit.

The model in this demo is deterministic and scripted. That keeps the proof focused on control-plane behavior rather than model quality, latency, cost, or prompt-following variance.

## Prerequisites

- Node.js 22.13.0 or newer;
- Bun 1.4.0 or newer for the source-checkout build command;
- Docker or Podman running locally; and
- the configured image already present locally.

The default command uses Docker and `node:24-bookworm-slim`:

```bash
bun install --frozen-lockfile
docker pull node:24-bookworm-slim
bun run build
bun run demo:hostile
```

Use the existing OCI environment variables to select Podman, a different preloaded image, or narrower limits. The harness never pulls an image implicitly.

## Expected evidence

Progress is written to stderr. A successful run writes one JSON document to stdout:

```json
{
  "schemaVersion": 1,
  "kind": "hostile-repository-demo",
  "ok": true,
  "runId": "hostile-demo-approved",
  "approvals": [
    "run_environment_command",
    "apply_environment_patch"
  ],
  "persistenceReopens": 2,
  "secretExcluded": true,
  "networkDenied": true,
  "hostUnchangedUntilApprovedImport": true,
  "exactlyOnceJournal": true,
  "staleHostImportBlocked": true,
  "redactedLedger": true
}
```

The output also includes the immutable image digest used for the proof. Pass `--keep` to retain the disposable workspace and print its location:

```bash
bun run demo:hostile --keep
```

The kept directory contains only fixture data and harness-owned evidence. Remove it when inspection is complete.

## Ninety-second recording outline

1. Show the hostile README and decoy `.env` fixture description.
2. Run `bun run demo:hostile`.
3. Highlight the first command approval and SQLite reopen.
4. Highlight `secretExcluded` and `networkDenied` from the OCI result.
5. Show that the host file stays unchanged until the separate import approval.
6. Highlight the completed exactly-once journal and redacted ledger.
7. End on the rejected stale-host import and the final JSON proof.

Suggested title: **Can your coding agent survive a hostile repository?**

## Live provider follow-up

The deterministic demo does not certify model-directed tool use. The billable live gate separately requires Meta, Qwen, and OpenAI to choose the exact OCI command, inspect the resulting patch, preserve both approvals, and import it:

```bash
ZHIVEX_HARNESS_LIVE=1 bun run smoke:live:execution
```

Provider evidence is date-, model-, endpoint-, account-, and credential-dependent. See [LIVE_CERTIFICATION.md](./LIVE_CERTIFICATION.md).

## Evidence limits

- Docker/Podman containers are not virtual machines or a managed hostile-code sandbox.
- The demo proves the documented policy against its exact fixture, runtime, image, and platform; it does not prove that arbitrary untrusted code is harmless.
- A redacted operational export is a defensive boundary, not a substitute for controlling prompts, repository eligibility, or operator access.
- The demo auto-approves only after asserting the expected pending operation inside a disposable fixture. Production operators should review each approval or use `--yes` only in an intentionally disposable environment.
- Coding quality and broad task success belong to separate evaluation and live-provider gates.
