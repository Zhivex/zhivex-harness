# Zhivex Harness desktop spike

HAR-HU-26 architecture validation. The alpha application flows in HU27–35 remain
separate. Uses an isolated React renderer, validated preload bridge and separate
runtime utility process sharing the existing Harness client/service contract.

```sh
bun install --cwd desktop --frozen-lockfile
bun run --cwd desktop build
bun run --cwd desktop typecheck
bun run --cwd desktop start --workspace /absolute/repository
bun run --cwd desktop smoke
bun run --cwd desktop package
bun run --cwd desktop smoke:packaged
```

The development launcher requires an explicit workspace. Provider keys, if used,
come from the host environment; do not pass them on the command line. The smoke
creates a temporary repository, uses an offline model and writes a screenshot plus
JSON report under the reported temporary directory. `--smoke-test` is an explicit
host-launch fixture mode, never a renderer request or implicit fallback.

The macOS arm64 .app is in `desktop/out/Zhivex Harness-darwin-arm64/`. It is unsigned
and unnotarized. Do not present it as a production installer. Packaging copies only
bundled application files and minimal metadata into the app; dependency caches,
source files and credentials are not copied. A separate Node installation is not
required. Docker/OCI remains optional and external; verify it using
`bun --no-env-file run scripts/oci-execution-smoke.ts` from the repository root.

For a dead prior owner, explicit `--recover` confirms its PID is dead before removing
transport files. It preserves databases and refuses a live owner. The default
service directory is `/tmp/zhx-desktop-<uid>` and must be canonical for this desktop
launcher. SIGTERM/normal quit drains accepted work; pending approvals are durable.
Do not forcibly remove ownership files to bypass a live service.

Architecture, threats and acceptance limits: [DESKTOP_ARCHITECTURE.md](../docs/DESKTOP_ARCHITECTURE.md).
