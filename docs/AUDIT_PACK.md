# Audit pack

Experimental operator export. It is not part of the stable root API. Import it
from `@zhivex-ai/harness/audit`. The commands are `export-audit` and
`verify-audit` on both `zhx` and `zhivex-code`.

```sh
export ZHIVEX_AUDIT_SIGNING_KEY="$(openssl rand -base64 32)"
zhx export-audit <task-id> --out ./audit-pack
zhx verify-audit --out ./audit-pack
```

`--signing-key-file <path>` overrides the environment variable. The key is 32 to
4096 bytes. A single trailing newline in the file is ignored. The key is not
written into the pack. `--out` and `--signing-key-file` are experimental flags
and are not members of the stable `CLI_OPTION_NAMES` tuple.

## What one bundle contains

The subject is a run id, or a guided task id. A run id produces one flat
directory. A guided task id produces one directory whose member runs live under
`runs/<id>/`. A task with a single recorded run stays flat.

| File | Source |
| --- | --- |
| `manifest.json` | Hashes and the HMAC. Not hashed inside itself. |
| `governance-report.json` | `exportHarnessGovernanceReport`. Pseudonymous tree projection. |
| `approvals.json` | `approvalDecisionViews`, then the same email and common-token redaction policy used by the activity journal. |
| `policy-decisions.json` | Activity events parsed with `harnessPolicyDecisionEventSchema`. |
| `redaction.jsonl` | The durable redacted activity journal for that run. This is not a second redactor and not a list of removed tokens. |
| `usage-ledger.json` | `inspectUsageLedger` on the run metadata, plus `UsageLedger.summary` when the operations database can be opened. |

The governance report already walks child runs. Approval, policy, redaction and
usage files describe the selected run, or each run on the task account. Export
does not call a model, execute a tool, or rewrite run state. Opening the usage
ledger uses the existing `UsageLedger.open` path, which ensures its transport
tables exist and does not append call rows. Estimates are not invoices.

Pass `--session <sessionId>` to include the retained activity journal. Without
it, the redaction log and policy file say `unavailable`. Retention and truncation
stay explicit. Session ids are not copied into the JSONL; the governance report
keeps its session pseudonym.

The first JSONL line is a `zhivex-redaction-log` header. Later lines are
`zhivex-redacted-activity` records: sequence, run id, optional time, and the
stored activity object.

## Manifest and HMAC

`manifest.json` is schema 1, kind `zhivex-harness-audit-pack`, integrity
`hmac-sha256`. `files` lists each payload path, byte length, and SHA-256.
Verification requires the directory to contain exactly those files plus
`manifest.json`. Paths stay inside the directory. Symlinks are rejected.
Unknown files, missing files, and hash mismatches fail.

The signature covers the canonical form of the manifest with the `signature`
field removed:

- arrays keep their order
- object keys are sorted lexicographically by UTF-16 code unit
- `undefined` object entries are omitted
- strings and numbers use `JSON.stringify`
- there is no whitespace

`signature.keyId` is the first 16 hexadecimal characters of SHA-256 over the
raw key bytes. `signature.value` is standard base64 of HMAC-SHA256 over the
canonical UTF-8 bytes. Verification uses a constant-time compare. A different
key fails with `AUDIT_PACK_KEY_MISMATCH` when the key id does not match, and
`AUDIT_PACK_SIGNATURE_INVALID` when the key id matches but the MAC does not.

HMAC is the mechanism in this repository that an operator can configure without
a new key format. Change envelopes already bind SHA-256 digests and leave
producer authenticity unverified. Desktop update manifests use Ed25519 because
a publisher and a verifier must not share a secret. An audit pack is an
operator seal of local records: the same party exports and verifies, or shares
the key out of band. Anyone who has the key can produce a pack that verifies.
This is integrity against modification by someone who does not have the key. It
is not a third-party attestation and it does not prove who ran the task.

## Commands

```sh
zhx export-audit <task-id> --out <directory> [--session <id>] [--json]
zhx verify-audit --out <directory> [--json]
```

`zhivex-code` accepts the same two commands. Locator flags match other state
commands. `--json` prints the manifest or the verification document. The
directory must not already exist for export. Verification reads it and does not
need the workspace.
