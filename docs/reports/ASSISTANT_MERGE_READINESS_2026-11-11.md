# Assistant integration readiness — 2026-11-11

The branch adds the private local Assistant package and experimental profiled
Harness API, plus Code terminal/web presentation changes and documentation
organization. It does not publish a new Harness or Assistant release.

## Integration changes

- Complete proactive notices, explicit reply watches, Google/Outlook metadata
  adapters, persistent policy and recovery tests, web controls and documentation.
- Add an Assistant pull-request workflow: Node 22.13.0 and 24, immutable dependency
  installation, local engine preparation, type checks, tests and an isolated
  installed consumer. Node 24 also exercises Chromium flows.
- Provide root commands `prepare:assistant`, `check:assistant` and
  `smoke:assistant:web`. The local candidate is required because the published
  Harness 1.6.3 does not contain the new profiled API.
- Separate setup state schemas and serialization into `setup-state.ts`; format
  setup, HTTP routing and proactive scheduling for review.
- Ensure browser launch failures release Assistant's local service and fixture.
- Canonicalize temporary fixture paths in Code Web registry tests so macOS's
  `/var` alias does not cause false confirmation failures.
- Incorporate remote main (6ea03e2) without conflicts. Keep existing feature,
  visual and documentation commits rather than rewriting their history.

## Local validation

Environment: macOS arm64, Bun 1.4.3, Node 22.21.0. All commands use Bun tooling.

| Validation | Result |
| --- | --- |
| `bun run check` | Passed: 2,376 tests, 0 failures, 1 platform skip; documentation, architecture, contracts, types, tooling, migrations, offline evaluation, benchmarks, MCP, Docker OCI and installed package smoke passed |
| `bun run prepare:assistant` | Passed with locked dependencies and local Harness artifact |
| `bun run check:assistant` | Passed: 128 tests, types, offline example and isolated consumer installation/tests |
| Final Assistant tests after formatting and smoke cleanup | 128 passed, 0 failures |
| `bun run smoke:assistant:web` | Passed: daily tools, proactive policy persistence/pause/authentication, Microsoft OAuth fixture, activation and mobile overflow checks |
| Code typecheck and tests | Passed: 170 tests, 0 failures |
| Code Web typecheck, lint and tests | Passed: 97 tests, 0 failures |
| Code Web browser smoke | Passed with no browser errors; offline provider fixtures |
| Workflow YAML parsing and `git diff --check` | Passed |

The root suite's platform skip covers the unsupported-platform branch of native
handoff on macOS. An initial sandboxed attempt failed to open local Unix sockets;
the complete authorized run outside that sandbox passed. Initial Code Web tests
exposed three non-canonical fixture path comparisons, which were corrected before
the successful rerun.

These results validate integration and offline behavior. They do not certify real
provider access, production Google/Microsoft/Telegram accounts or the 90 planned
Assistant evaluation trials. No live message was sent and no release was published.
GitHub Actions results remain a separate check on the submitted commit.
