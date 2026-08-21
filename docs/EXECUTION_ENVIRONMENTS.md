# Enforced execution environments

Zhivex Harness `0.6.x` adds an opt-in local OCI backend for shell-class work. The default remains `execution=none`: repository tools and declared checks keep their existing narrow contract, and no generic command tool is exposed. Selecting `execution=oci` acquires an SDK execution-environment session, copies an eligible workspace snapshot, and routes repository tools, checks, environment commands, and child agents through that session.

This is a local enforced runner. It is not a hosted sandbox, a virtual machine, or a promise that a compromised container runtime cannot affect its host.

## Trust boundary

The harness trusts the operator, host OS, Docker or Podman daemon, configured image, Zhivex packages, and its own state directory. The model and code executed in the container are outside that trust boundary.

The OCI policy is enforced for one acquired run session, with each command committed as a separate validated transaction:

- `--network none`;
- a read-only container root filesystem;
- every Linux capability dropped and `no-new-privileges` enabled;
- the host numeric user/group rather than root;
- a size-bounded writable `tmpfs` at `/workspace` plus a separate bounded `tmpfs` at `/tmp`;
- an optional host `node_modules` directory mounted read-only at `/dependencies` and linked into the container workspace;
- exact argv execution through the configured entrypoint, with no shell interpolation;
- a fixed container environment containing only `HOME`, `TMPDIR`, `NPM_CONFIG_CACHE`, and `CI`;
- time, output, memory, CPU, PID, workspace-size, and per-file patch limits.

The snapshot is populated through the normal bounded workspace discovery contract. Git internals, harness state, dependency/build output, `.env`, `.npmrc`, private keys, secret-like paths, external symlinks, and special files are not copied. Provider credentials and arbitrary host environment variables are never passed to the container.

When the backend is disabled, these OCI claims do not apply. The harness responds by omitting `run_environment_command`, not by falling back to an unrestricted host shell.

## OCI configuration

Preload the image intentionally; the harness never pulls or updates images:

```bash
docker pull node:24-bookworm-slim
bun run dev doctor --execution oci
bun run dev run --execution oci --yes "implement the change, test it, inspect the environment patch, and import it"
```

Podman is also supported through `--oci-runtime podman`. Defaults are:

| Setting | Default |
| --- | ---: |
| Backend | `none` |
| Runtime | `docker` |
| Image | `node:24-bookworm-slim` |
| Allowed commands | `node,npm` |
| Process time | 120,000 ms |
| Retained process output | 20,000 bytes |
| Memory | 1,024 MB |
| PIDs | 128 |
| CPUs | 2 |
| Snapshot | 64 MiB |
| Imported file | 1 MiB |
| `/tmp` tmpfs | 256 MB |

CLI flags are listed in [CLI.md](./CLI.md). The matching environment variables are:

```text
ZHIVEX_HARNESS_EXECUTION
ZHIVEX_HARNESS_OCI_RUNTIME
ZHIVEX_HARNESS_OCI_IMAGE
ZHIVEX_HARNESS_OCI_ALLOWED_COMMANDS
ZHIVEX_HARNESS_OCI_MAX_PROCESS_RUNTIME_MS
ZHIVEX_HARNESS_OCI_MAX_PROCESS_OUTPUT_BYTES
ZHIVEX_HARNESS_OCI_MAX_MEMORY_MB
ZHIVEX_HARNESS_OCI_MAX_PIDS
ZHIVEX_HARNESS_OCI_MAX_CPUS
ZHIVEX_HARNESS_OCI_MAX_WORKSPACE_BYTES
ZHIVEX_HARNESS_OCI_MAX_FILE_WRITE_BYTES
ZHIVEX_HARNESS_OCI_TMPFS_MB
```

`ZHIVEX_HARNESS_OCI_ALLOWED_COMMANDS` is comma-separated and must include at least one supported package manager (`npm`, `pnpm`, `yarn`, or `bun`). `run_check` selects the manager from `packageManager` or one unambiguous lockfile and defaults to npm. Adding an executable permits that bare entrypoint but does not add a shell or wildcard. The configured image must always provide Node for the internal controller; Bun-managed repositories additionally need a Node-and-Bun image and `bun` in the allowlist. Each environment command still requires normal high-risk interrupt approval unless the operator deliberately supplied `--yes`.

The image is inspected before model construction. Its immutable image ID/digest, runtime/server version, complete policy, canonical workspace identity, and environment manifest contribute to the run binding. A missing daemon/image fails before model execution. A changed image or policy makes a paused resume fail closed.

## Snapshot and patch import

The acquired environment contains two owner-only copies under `<state-dir>/environments/<run-hash>`:

- `base`: the immutable comparison snapshot;
- `workspace`: the mutable snapshot used by repository tools and containers.

In `0.9.x`, acquisition keeps only a bounded metadata inventory in memory, writes each verified source file to `base` once, and creates `workspace` with filesystem copy-on-write cloning when available. Unsupported filesystems fall back to an independent normal copy. Patch comparison inventories both trees but rereads file content only for paths whose digest or mode changed. This changes host I/O and memory use, not the two-copy trust model: mutations in `workspace` remain observable as a patch against `base` and never mutate `base`.

`environment_status` includes cumulative `io` counters for inventory passes/pages, verified content reads/bytes, snapshot files/bytes, clone fallbacks, container starts/reuses, successful workspace publications, and changed-workspace exports. They are diagnostics for profiling and regression tests, not admission evidence or a stable performance guarantee.

The first command seeds a size-bounded `/workspace` tmpfs from the durable snapshot and subsequent successful commands reuse that run container while the host snapshot fingerprint remains unchanged. The container stays paused while idle. After every command the harness rejects surviving background processes, clears `/tmp`, and computes a canonical workspace seal. An unchanged seal takes a no-export fast path. A changed seal freezes the container, copies `/workspace` out through the runtime into a new owner-only staging directory, rejects symlinks, hard links, special files, oversized workspaces, excessive entries, and oversized changed files, then atomically replaces the durable snapshot. The host snapshot is never mounted writable into an untrusted container.

Failed, cancelled, timed-out, output-limited, invalid, or background-spawning commands do not publish partial workspace mutations: their container and tmpfs volume are destroyed. A later command reseeds from the last durable snapshot. Repository-tool changes made outside the container alter the host-side snapshot fingerprint, which likewise discards the warm container and reseeds before execution. This preserves one durable source of truth instead of silently carrying stale container state.

`inspect_environment_patch` compares them deterministically and returns a run-bound patch identifier plus create/update/delete entries, content digests, and before/after permission modes. Content-identical mode changes remain visible, and modes are part of the reviewed `patchId`. It rejects binary changes, more than 50 files, a patch above 4 MiB, or a file above the configured import ceiling.

`apply_environment_patch` is a different high-risk tool and approval. Immediately before import it recomputes the patch identifier and verifies every host precondition against the digest and mode captured at acquisition. Creates must still be absent; updates and deletes must still match. Writes publish content and mode atomically, including newly created executable files and mode-only updates; rollback restores both. Deletions use recoverable quarantine, and a deletion failure triggers best-effort rollback. The host remains unchanged until this import succeeds.

Because repository tools are snapshot-scoped while OCI is active, `apply_patch`, moves, quarantine, and restore alter only the snapshot. The model-facing `git_diff` tool is omitted in this mode because it would read the canonical host outside the environment boundary; the caller still receives the canonical final host Git status/diff after any approved import.

## Resource and network policy

Every command receives the configured timeout and combined output ceiling. Cancellation, timeout, or output overflow kills the client process and force-removes the named container. The runtime also applies the memory, PID, CPU, read-only-root, workspace-tmpfs, `/tmp`-tmpfs, capability, and network controls listed above.

The environment manifest declares zero network requests and bytes and denies undeclared tools. Consequently, all MCP configuration is rejected before discovery when OCI enforcement is active: executing a client on the host would bypass the environment boundary, while executing a network client inside the container would violate `network=deny`. Governed MCP remains available in a separate non-OCI run, with mandatory durable approval for network tools. `stdio` MCP remains unavailable.

PID limits are the primary fork-bomb control. Memory and CPU limits constrain resource exhaustion, while the harness timeout and cancellation path bound command duration. These limits reduce impact; they are not a substitute for isolating the container daemon on a dedicated host when running actively hostile code.

## Lifecycle and recovery

Environment artifacts are keyed by a hash of the durable run ID and include an owner-only metadata file bound to that exact run, workspace, environment fingerprint, and image. Reacquisition reuses the same snapshot only when every binding matches.

Each runtime container and temporary workspace volume carries `com.zhivex.harness.execution=v1` and a hashed run label. The container remains paused between successful commands and session release force-removes all resources for that run before recording status and release time. `runs cleanup --before <cutoff>` removes only released terminal artifact directories older than the cutoff; with OCI configured it also removes labeled containers in `created`, `exited`, `dead`, or `paused` state and unused labeled volumes. Unknown directories, symlinks, active resources, and unlabeled OCI resources are skipped.

Crash recovery relies on the same labels and durable artifacts. An operator can rerun cleanup after a process crash. The harness does not issue broad container/volume prune commands and never deletes an unlabeled OCI resource.

## Migration from 0.5.x

Configuration schema version advances from `3` to `4`. Update schema-pinned callers and regenerated configuration snapshots. The run-store database schema does not require a rewrite.

The default backend remains `none`, so upgrades do not unexpectedly start a container daemon or expose shell execution. Enable OCI explicitly and preload its image. Paused runs created with `0.5.x` have a different harness/tool fingerprint and should be completed with their original version rather than silently rebound.

Applications constructing the harness can inject a `HarnessOciRuntimeAdapter` for a controlled runtime implementation. They should use the exported SDK environment rather than bypassing authorization or importing snapshot files directly.

## Migration from 0.9.x

The `0.10.x` execution policy advances to `2026-08-21-v3`, changes the default image from Bun to Node 24, and makes repository checks package-manager-aware. Complete paused `0.9.x` environment approvals with their original artifact; the changed image, allowlist, controller, and policy fingerprint intentionally prevent a silent resume under `0.10.x`. Durable SQLite state remains readable without conversion.

## Certification

The deterministic tests use an injected runtime to cover acquisition, secret exclusion, snapshot-only mutation, patch binding/import, separate approvals, image-fingerprint resume rejection, release, and safe artifact cleanup. The installed-package smoke imports the public OCI API and proves that a consumer can perform the same snapshot/import flow.

`bun run smoke:oci` exercises a real Docker/Podman daemon and preloaded image. It verifies secret exclusion, denied outbound network, denied root-filesystem writes, warm-container reuse, host-tool reseeding, background-process rejection, snapshot mutation, enforced workspace capacity, package checks, host non-mutation before import, approved import, cancellation, release, orphan cleanup, and artifact retention cleanup. `bun run benchmark:oci` reports first-command, warm no-op, mutation, snapshot, and runtime-I/O measurements on a configurable synthetic repository. The smoke skips locally when no daemon is available unless `ZHIVEX_HARNESS_OCI_REQUIRED=1`; Linux CI, release validation, and live certification set that variable so absence is a failure.

Provider certification is separate and billable. The live workflow runs the required OCI gate before the model-directed Meta, Qwen, and OpenAI matrices. A deterministic OCI pass does not by itself certify a provider, and live provider success does not replace exact installed-artifact or published-registry proof.

## Known limits

- Docker and Podman use different host security implementations; current gates certify behavior, not identical internals.
- The default Node image and read-only host `node_modules` mount optimize npm-managed JavaScript/TypeScript checks. pnpm, Yarn, Bun, and other ecosystems need an explicit Node-capable image and executable allowlist, and dependencies should be prepared without exposing secrets.
- The local container daemon, kernel, image, and mounted dependency tree remain trusted. This backend is not a microVM boundary.
- Network is deny-only in this policy version. Domain allowlists, package installation, browser automation, and network MCP require a future policy/backend rather than an implicit exception.
- Patch import accepts bounded UTF-8 text changes only. Binary artifacts and large generated trees must use a future reviewed artifact-transfer contract.
- Per-file atomic publication plus best-effort rollback is not a transaction across power loss or hostile concurrent host writers.
- The harness does not build, pull, scan, sign, or attest the configured image. Operators should pin and govern images according to their deployment policy.
