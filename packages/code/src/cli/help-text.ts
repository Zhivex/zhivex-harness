import { shortCliHelp } from "./cli-help.js";
import { PROVIDERS } from "@zhivex-ai/harness/engine";
import { CODE_VERSION } from "../version.js";

export const CLI_HELP_TEXT = shortCliHelp(CODE_VERSION);

export const CLI_FULL_HELP_TEXT = `Zhivex Code v${CODE_VERSION}

Everyday commands:
  zhivex-code                              Start the interactive console
  zhivex-code --continue                   Reopen the latest conversation
  zhivex-code --session <id>                Reopen a selected conversation
  zhivex-code init [--profile <name>] [--provider <id>] [--model <id>]
  zhivex-code run [options] "task"
  zhivex-code run [options] -              Read a UTF-8 task from stdin (up to 1 MiB)
  zhivex-code review [options] "review task"
  zhivex-code chat [options] [--continue|--session <id>]
  zhivex-code providers [--json]
  zhivex-code doctor [options] [--json]

Advanced operations and automation:
  zhivex-code resume [options] <runId> --approve|--deny
  zhivex-code runs list [--status <status>] [--limit <n>] [--json]
  zhivex-code sessions list|inspect|rename|fork|archive
  zhivex-code sessions list --search <literal title or session ID>
  zhivex-code run --pricing-file <prices.json> --usage-limit-usd <amount> <task>
  zhivex-code changes create <input.json> --patch <artifact>
  zhivex-code changes verify <envelope.json> --patch <artifact> [--preconditions <file>]
  zhivex-code state status
  zhivex-code state export <backup.json>
  zhivex-code state import <backup.json> [--apply]

Legacy Harness installations retain their own zhx and zhivex-harness commands.

Options (automation and advanced configuration):
  --profile <name>                Explicit personal provider/model profile
  --update                       Update an existing profile (init only)
  --provider <${PROVIDERS.join("|")}>  Provider (default: openai)
  --model <id>                   Override the default model
  --reasoning <level>            default, none, minimal, low, medium, high, xhigh, max (model-dependent)
  --compaction-model <id>        Opt into model-assisted compaction with this model
  --compaction-provider <id>     Compaction provider (defaults to the primary provider)
  --route <role=provider[:model]> Route a subagent role; repeatable
  --session <id>                 Open a durable interactive session
  --continue                     Open the latest durable interactive session
  --workspace <path>             Target workspace (default: cwd)
  --service <credentials.json>   Use the private local runtime (run/resume/chat/sessions)
  --state-dir <path>             Durable run-state directory
  --mcp-config <path>            Declarative governed MCP JSON configuration
  --context-config <path>        Project context/rules/skills manifest (default: .zhivex/harness.json)
  --no-memory                   Disable project-memory retrieval for this invocation
  --source <text>               Provenance label for explicit memory input
  --no-project-context           Disable AGENTS.md and the project context manifest
  --patch <path>                 Exact patch/artifact bytes bound to a change envelope
  --preconditions <path>         Verification preconditions JSON for changes verify
  --now <ISO-8601 UTC>           Explicit millisecond verification time (default: current time)
  --require-verified-delivery    Require a verified change before completing the task
  --execution <none|oci>         Enforced execution backend (default: none)
  --oci-runtime <docker|podman>  Local OCI runtime (default: docker)
  --oci-image <reference>        Preloaded immutable-capable OCI image
  --oci-allow-command <name>     Allow one argv executable in OCI; repeatable, include a package manager
  --oci-shell <deny|ask>         Expose approval-gated sh inside OCI (default: deny)
  --oci-max-process-runtime-ms <n> Per-command timeout (default: 120000)
  --oci-max-process-output-bytes <n> Combined output ceiling (default: 20000)
  --oci-max-memory-mb <n>        Container memory ceiling (default: 1024)
  --oci-max-pids <n>             Container process ceiling (default: 128)
  --oci-max-cpus <n>             Container CPU ceiling (default: 2)
  --oci-max-workspace-bytes <n>  Snapshot size ceiling (default: 67108864)
  --oci-max-file-write-bytes <n> Patch file ceiling (default: 1048576)
  --oci-tmpfs-mb <n>            Writable /tmp ceiling (default: 256)
  --store <sqlite|file>          Durable backend (default: sqlite)
  --tenant <id>                  Durable tenant scope (default: local)
  --user <id>                    Optional durable user scope
  --namespace <id>               Optional scope namespace (default: workspace digest)
  --idempotency-key <key>        Reuse the same durable run for duplicate requests
  --max-steps <n>                Finite positive step limit (default: 50)
  --max-tool-calls <n>           Maximum tool calls (default: 32)
  --max-tool-errors <n>          Maximum failed tool calls (default: 4)
  --no-token-budget             Disable cumulative token budgets (default for new local chat)
  --token-budget                Enable cumulative token budgets (default for run/review)
  --context-tokens <n>           Context compaction threshold, not cumulative usage (default: 40000)
  --max-input-tokens <n>         Maximum measured input tokens (default: 100000)
  --max-output-tokens <n>        Maximum measured output tokens (default: 30000)
  --max-total-tokens <n>         Maximum total tokens (default: 120000)
  --max-cost-usd <amount>        Optional measured cost ceiling
  --input-cost-per-million <n>   Input-token pricing for the cost ceiling
  --output-cost-per-million <n>  Output-token pricing for the cost ceiling
  --timeout-ms <n>               Wall-clock timeout (default: 900000)
  --allow-check <script>         Allow one package.json script; repeatable
  --require-capability <name>    Reject incompatible models before a run; repeatable
  --subagent <profile>           Enable explorer, implementer, tester, or reviewer; repeatable
  --subagent-max-steps <n>       Independent child step budget (default: 8)
  --subagent-max-tool-calls <n>  Independent child tool budget (default: 16)
  --subagent-max-tool-errors <n> Independent child failed-tool budget (default: 3)
  --subagent-max-input-tokens <n> Independent child input-token budget (default: 30000)
  --subagent-max-output-tokens <n> Independent child output-token budget (default: 8000)
  --subagent-max-total-tokens <n> Independent child token budget (default: 36000)
  --subagent-timeout-ms <n>      Independent child timeout (default: 300000)
  --reviewer <profile>           Read-only review group member; repeatable
  --max-parallel-reviews <1-4>   Review group concurrency ceiling (default: 2)
  --approval-mode <mode>        ask (default), auto, or restricted (deny approvals)
  --yes                          Alias for automatic approvals within existing permissions
  --json                         Emit structured final output
  --jsonl                        Stream redacted JSON Lines, then the final result
  --cursor <cursor>              Continue a paginated run listing
  --before <date|timestamp>      Explicit retention cutoff for runs cleanup
  --reason <text>                Bounded operator cancellation reason
  --cascade                      Cancel a run and its known child runs
  --final                        Record terminal cancellation immediately
  --apply                        Apply a validated state import (default: dry-run)
  -h, --help                     Show this help
  -v, --version                  Show the version

Exit codes:
  0  Success
  1  Run-time or agent failure
  2  Invalid CLI usage
  3  Doctor found a blocking local configuration problem

Credentials:
  OpenAI: OPENAI_API_KEY
  Meta:   MODEL_API_KEY
  Qwen:   DASHSCOPE_API_KEY or QWEN_API_KEY
  Gemini: GEMINI_API_KEY or GOOGLE_GENERATIVE_AI_API_KEY`;
