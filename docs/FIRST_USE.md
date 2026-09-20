# First use from a clean environment

Use a supported Node runtime and Bun for the example's checks. Copy the packaged
`examples/first-use` directory to a disposable working directory. Initialize Git
there so `git_diff` can show the reviewed changes. Run `bun test` to verify the
unchanged example.

1. Run `zhx init --profile first-use --provider openai --model gpt-5.6-luna`.
   Substitute another supported provider/model if desired. The profile stores
   provider/model selection, never an API key.
2. Set the provider credential in your shell using its secure input mechanism.
   Do not paste it into a task or commit it. `zhx providers` lists variable names.
3. Run `zhx doctor --profile first-use --workspace .`. This checks credential
   presence, runtime and workspace configuration, not whether the remote API
   accepts the key. The first actual model request verifies that boundary.
4. Run `zhx chat --profile first-use --workspace . --allow-check test`.
5. Ask: “Extend greeting to trim whitespace and return Hello, world! for an empty
   name. Add focused tests. Read the existing files first, request approval for
   changes, run the test check and inspect the final diff.”
6. Review the complete paths, digest-bound edits and exact test command before
   answering the approval. Use `/diff` to inspect the result, `/context` to inspect
   context and `/usage` to inspect provider/model usage. No price means unknown
   cost. A completed model turn alone does not certify checks.
7. Exit and reopen with `zhx chat --continue --workspace .`. Pending approvals
   and durable status appear before a new task. `/sessions [text]` searches this
   project; `/rename <title>` labels the current session.

Missing credentials: set the named environment variable and rerun doctor. Rejected
credentials: correct or rotate the key at the provider, then retry a read-only task.
Provider unavailable: check its availability, wait or select another configured
provider for a new task; inspect persisted runs before repeating an edit.
OCI unavailable: start Docker/Podman and preload the configured immutable image,
then rerun doctor. Do not bypass requested isolation. See [support](SUPPORT_MATRIX.md)
for the platforms and providers actually certified.

The repository's `bun run scripts/first-use-smoke.ts /absolute/installed/dist/cli.js`
reproduces initialization, secret-free diagnostics, an approved edit/check/diff,
restart, missing/invalid credentials, unavailable provider and missing OCI with
an entirely local transport fixture. `smoke:artifact` runs it on an installed
tarball. This proves the client flow; it is not live credential certification.
