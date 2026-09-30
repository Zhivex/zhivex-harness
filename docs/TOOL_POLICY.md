# Trusted tool policy (experimental)

An application can pass `toolPolicyFile` to `createHarness`. The CLI accepts
`--tool-policy /absolute/private/policy.json` for run, chat, review and resume.
The local service host accepts the same flag at startup. Service clients cannot
supply it: policy belongs to the process constructing the runtime.

```json
{
  "schemaVersion": 1,
  "rules": [
    {
      "id": "protect-private-file",
      "tools": ["read_file", "read_files"],
      "paths": ["private.txt"],
      "decision": "deny",
      "reason": "This file is outside the task scope"
    }
  ]
}
```

Choose the file explicitly outside the workspace and its containing repository.
The loader does not read policy instructions from AGENTS.md, skills, model output,
environment variables or client requests. It requires a regular file owned by the
current user, private permissions such as `0600`, one hard link, no symlink in the
path, valid UTF-8, a strict schema and at most 128 KiB. Unknown fields, versions
and unavailable tool names are errors. Never place secrets in rule reasons.

Rules use exact tool and workspace-relative file names, without wildcards.
The strongest matching decision wins: deny, then ask_user, then allow. Allow
does not grant filesystem permissions or remove an existing approval. ask_user
uses the current approval mechanism, including its configured automatic mode;
it does not independently require a human. Human-only review is separate work.

Built-in file resolvers cover read_file, read_files, propose_edits, apply_patch,
apply_reviewed_edits, apply_reviewed_replacement, move_file and quarantine_file.
Move rules inspect both endpoints; multi-file tools inspect every target.
Path-scoped rules for other tools fail at construction because shell commands,
directory queries and opaque restore IDs do not enumerate exact affected files.
Use a tool-wide rule when appropriate. A rule on one named tool does not restrict
other tools that could access the same data; this is an additional control, not
a replacement for the workspace permission boundary or sandbox.

File policies use `builtin-exact-files-v1`. Existing application-supplied policy
objects retain their explicit custom resolver interface; do not combine that
interface with toolPolicyFile. The policy and resolver version affect the durable
runtime fingerprint inherited by children. An already-open runtime keeps its
compiled policy when the file changes. Restart to load a change; incompatible
durable runs must not be resumed under the replacement policy. CLI resume requires
the operator to supply the policy again; the saved run does not authorize reading
an arbitrary policy path.

This capability remains experimental and has no effect when omitted. Local test
results and installed-package acceptance are tracked separately in the HU52 report.

HU53 adds an experimental opt-in `explicitReview: { "schemaVersion": 1 }` at
the policy root. It requires host-issued review evidence for all positive approval
resolutions and affects the policy digest. It does not add approval requirements
to otherwise unrestricted tools. Automatic resolution cannot satisfy it. Client
channels without compatible review evidence receive EXPLICIT_REVIEW_REQUIRED and
leave the operation pending. The local CLI in ask mode displays a complete bounded
payload and issues host evidence after explicit confirmation, without cached session
grants. With this policy, `resume --approve` also requires interactive review;
noninteractive invocation remains pending. Desktop accepts the operator-owned
policy through its `--tool-policy` startup argument. Its main process consumes a
bounded, expiring review ticket and sends the exact decision to the runtime through
their private process channel. The renderer cannot issue review evidence, and the
public HTTP command endpoint cannot use this private channel. Ordinary service
clients must leave positive approvals pending under this policy.
Local review evidence is not corporate identity and does not protect against a
compromised host process.

Approval history records the decision origin before effects: interactive for a
local answer, automatic for automatic modes or reused session grants, application
for ordinary API/protocol decisions, and unknown for historical records without
provenance. Each row includes its channel and the host policy digest when present.
Origin describes how the decision entered the host; an interactive label alone
is not evidence of the complete review required by explicitReview. Without that
option, recording provenance does not impose its five-minute review deadline.
An incompatible runtime fingerprint is rejected before recording approval intent.
