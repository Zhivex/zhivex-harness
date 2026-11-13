# Opt-in auto-approve

Manual is the default. Nothing is applied until a person decides.

| Mode | What can proceed without a prompt |
| --- | --- |
| `manual` | Nothing. This is today's review. |
| `auto-edits` | File edits whose paths stay inside the workspace root. |
| `auto-limits` | Those edits, plus commands whose executable is on the allowlist. |

## Always ask

These wait for a person in every mode, including when the command is allowlisted:

- Network or egress, including `curl`, `wget`, `ssh`, and any command that carries an `http` or `https` URL.
- Deletes outside the workspace.
- Writes outside the workspace root.
- Secret or credential files (`.env`, `credentials`, `.npmrc`, `.pypirc`, `.netrc`, `id_rsa`, `id_ed25519`, `*.pem`, `*.key`, and a `secrets` or `credentials` directory).
- `git push`.
- Package publish (`npm`, `pnpm`, `yarn`, `bun`, `cargo`).
- Any operation once a spend or token limit is already reached.

There is no flag that skips this list. A batch that mixes a safe edit with one of these stays on the review screen. `--approval-mode auto` and `--yes` are the older approve-all switch used by non-interactive runs. They are not this feature. Tool policy and explicit host review still apply.

## Where it is set

The workspace file is `.zhivex-harness/approval.json`. That directory is already protected from workspace tools.

```json
{
  "mode": "auto-limits",
  "commandAllowlist": ["bun", "git"]
}
```

Allowlist entries are exact executable names. Wildcards and paths are rejected. `git` on the list still does not allow `git push`.

The CLI flag and a session command override the file for this process:

```sh
zhivex-code --auto-approve auto-edits
zhivex-code --auto-approve auto-limits --auto-approve-allow bun --auto-approve-allow git
```

In the terminal, `/auto-approve` shows the mode, `/auto-approve manual` changes this session, and `/auto-approve workspace manual` writes the file. `m` during a review, or `/manual`, returns to Manual without rewriting the file. The status line names the mode.

In the web workspace the header chip shows the same mode. The dialog can save it for this session or this workspace. `m`, while you are not typing, returns to Manual for the session.

## Audit and undo

Each auto-approved operation is appended to `.zhivex-harness/auto-approvals.jsonl` with the mode, the reason, and a bounded snapshot of the previous file text (256 KiB of UTF-8). `/undo` restores the latest snapshot when every file still matches the approved text. The web Approvals dialog does the same per change. A later edit, a binary file, or a snapshot that was too large is not reverted.
