# Local daily workflow acceptance

Branch: `feat/cli-daily-workflow`, based on merged PR #64 (`573b02a906f33b7e6202e98e4ed8caceef00806c`). Changes were uncommitted during validation. This is local development evidence, not protected RC certification or GA approval.

- Full `bun run check`: passed, 407 tests, historical migrations, evaluations/benchmarks, MCP, real Docker 29.7.2 OCI smoke, and installed package smoke including a Node PTY workflow.
- PTY coverage: context completion, protected attachments, explicit multiline paste, native Alt+Enter, cancellation and same-session continuation, approval interruption, process restart, and durable approval recovery.
- Real OpenAI `gpt-5.6-luna` acceptance from an installed RC.13 development tarball: two tasks passed in attempt 4. Each fixture failed its independent baseline tests, then passed independent post-run tests. Tests and package configuration remained unchanged.
- Attempt 1–3 failed before approval because the model invented first-page list cursors. Attempt 4 uses explicit nullable cursor schemas; invalid non-null cursors remain rejected. Earlier attempts are preserved unchanged.
- Only task-specific implementation files and the declared `node --test` check may be approved by this script. Temporary workspaces are removed. Shared reports exclude prompts, tool payloads, credentials, and raw errors.

Reproduce after building, packing, and installing the candidate in a temporary directory:

```sh
ZHIVEX_HARNESS_LIVE=1 bun --env-file=.env run scripts/daily-workflow-live-smoke.ts \
  /absolute/installed/node_modules/@zhivex-ai/harness/dist/index.js \
  /absolute/new-report.json
```

Requires an OpenAI key and makes paid provider calls. Use a new report path for each attempt. Each report binds the installed entry module SHA-256, not a protected release commit or complete package integrity. Provider coverage here is OpenAI only; broader provider and exact-artifact gates remain required for release.
