import { CLI_COMMAND_OPTION_CONTRACTS, type CliCommandOptionContractKey } from "./cli-options.js";

const usage: Record<string, string> = {
  "memory:remember": 'zhx memory remember "content" [--source "provenance"]',
  "memory:suggest": 'zhx memory suggest "content" [--source "provenance"]',
  "memory:list": 'zhx memory list',
  "memory:read": 'zhx memory read <id>',
  "memory:update": 'zhx memory update <id> <revision> "content" [--source "provenance"]',
  "memory:forget": 'zhx memory forget <id> <revision>',
  "memory:accept": 'zhx memory accept <id> <reviewedRevision>',
  "memory:clear": 'zhx memory clear',
  "memory:enable": 'zhx memory enable',
  "memory:disable": 'zhx memory disable',
  "memory:context": 'zhx memory context "query"',
  "checkpoints:storage": "zhx checkpoints storage",
  "checkpoints:prune-review": "zhx checkpoints prune-review <checkpoint:id|restore:id> [...]",
  "checkpoints:prune-apply": "zhx checkpoints prune-apply <reviewedPlanId> <checkpoint:id|restore:id> [...]",
  "checkpoints:list": "zhx checkpoints list <sessionId>",
  "checkpoints:capture": "zhx checkpoints capture <sessionId> <turnId> <path> [paths...]",
  "checkpoints:inspect": "zhx checkpoints inspect <checkpointId>",
  "checkpoints:prepare": "zhx checkpoints prepare <checkpointId>",
  "checkpoints:review": "zhx checkpoints review <operationId>",
  "checkpoints:apply": "zhx checkpoints apply <operationId> <reviewedProposalId>",
  "checkpoints:recover": "zhx checkpoints recover <operationId> <existingForkSessionId>",
  init: "zhx init [--provider <id>] [--model <id>] [--profile <name>] [--update]",
  run: 'zhx run [options] "task" | zhx run [options] -', review: 'zhx review [options] "review task" | zhx review [options] -',
  chat: "zhx [--continue | --session <id>]", providers: "zhx providers [--json]",
  policy: "zhx policy [options] [--json]",
  doctor: "zhx doctor [options]", resume: "zhx resume <runId> --approve|--deny",
  "runs:list": "zhx runs list [options]", "runs:inspect": "zhx runs inspect <runId>",
  "runs:cancel": "zhx runs cancel <runId> [options]", "runs:cleanup": "zhx runs cleanup --before <date> [options]",
  "runs:export": "zhx runs export <runId>", "runs:report": "zhx runs report <runId> [envelope.json] [--session <sessionId>] [--json]", "sessions:list": "zhx sessions list [--search <text>]",
  "sessions:inspect": "zhx sessions inspect <sessionId>", "sessions:rename": 'zhx sessions rename <sessionId> "title"',
  "sessions:fork": "zhx sessions fork <sessionId>", "sessions:archive": "zhx sessions archive <sessionId>",
  "changes:create": "zhx changes create <input.json> --patch <artifact>",
  "changes:verify": "zhx changes verify <envelope.json> --patch <artifact> [options]",
  "state:status": "zhx state status", "state:export": "zhx state export <backup.json>",
  "state:import": "zhx state import <backup.json> [--apply]", version: "zhx --version",
};

export const shortCliHelp = (version: string) => `Zhivex Harness v${version}

Start in your project:
  zhx                         Open the conversation (first-use setup if needed)
  zhx --continue              Reopen the latest conversation
  zhx run "task"              Run one task for a script or automation
  zhx doctor                  Check local configuration

Inside the console, type / for common actions or /help for guidance.
  zhx init                    Configure a provider/model profile explicitly
  zhx <command> --help        Show help for one command
  zhx help all                Show every command and advanced option
  zhx --version               Show the installed version

Requires Node >=22.13. The console guides API key setup; automation uses environment keys.
zhx chat and zhivex-harness remain supported aliases.`;

export function resolveHelpTopic(parts: string[], explicit: boolean): string | undefined {
  if (!explicit || !parts.length) return undefined;
  const topic = parts.join(":");
  if (topic === "all" || Object.hasOwn(usage, topic) || Object.keys(usage).some(key => key.startsWith(`${topic}:`))) return topic;
  throw new Error(`Unknown help topic: ${parts.join(" ")}. Use zhx help all.`);
}

export function formatCliHelp(topic: string | undefined, version: string, full: string): string {
  if (!topic) return shortCliHelp(version);
  if (topic === "all") return full;
  const contract = CLI_COMMAND_OPTION_CONTRACTS[topic as CliCommandOptionContractKey];
  if (!contract) {
    return `Zhivex Harness — ${topic}\n\n` + Object.entries(usage)
      .filter(([key]) => key.startsWith(`${topic}:`)).map(([, command]) => `  ${command}`).join("\n") +
      `\n\nUse zhx ${topic} <subcommand> --help for its options.`;
  }
  const descriptions = new Map<string, string>();
  for (const line of full.split("\n")) {
    const match = line.match(/^  (--[\w-]+)(?:\s|$)/);
    if (match) descriptions.set(match[1]!, line);
  }
  const extra: Record<string, string> = {
    "--approve": "  --approve                     Approve the pending batch",
    "--deny": "  --deny                        Deny the pending batch",
    "--status": "  --status <status>             Filter by run status; repeatable",
    "--limit": "  --limit <n>                   Maximum number of results",
    "--search": "  --search <text>               Literal conversation title or ID filter",
    "--pricing-file": "  --pricing-file <file.json>    Operator-supplied price estimates",
    "--tool-policy": "  --tool-policy <absolute.json> Host-owned tool policy outside the repository",
    "--usage-limit-usd": "  --usage-limit-usd <amount>    Per-run monetary limit; requires pricing",
    "--version": "  --version                     Show the installed version",
  };
  const examples: Record<string, string[]> = {
    run: ['zhx run "Explain this repository"', 'zhx run --profile daily --json "Review the parser"', 'git diff | zhx run -'],
    review: ['zhx review "Review error handling"', 'zhx review - < review-task.txt'],
    init: ['zhx init --profile daily', 'zhx init --profile daily --update --model <id>'],
    doctor: ['zhx doctor --profile daily', 'zhx doctor --workspace /path/to/project'],
  };
  const groups = new Map<string, string[]>();
  for (const name of contract.allowed) {
    const group = name.startsWith("--oci-") || ["--execution", "--require-verified-delivery", "--allow-check", "--yes"].includes(name) ? "Execution and approvals" :
      /subagent|reviewer|parallel-reviews|^--route$/.test(name) ? "Specialist agents" :
      /cost|pricing|usage-limit|^--max-|^--timeout/.test(name) ? "Budgets and limits" :
      ["--state-dir", "--store", "--tenant", "--user", "--namespace", "--idempotency-key"].includes(name) ? "State and scope" :
      ["--mcp-config", "--context-config", "--no-project-context", "--require-capability"].includes(name) ? "Context and capabilities" : "Common options";
    const lines = groups.get(group) ?? [];
    lines.push(descriptions.get(name) ?? extra[name] ?? `  ${name}`);
    groups.set(group, lines);
  }
  const sections = ["Common options", "Execution and approvals", "Budgets and limits", "Specialist agents", "Context and capabilities", "State and scope"]
    .filter(group => groups.has(group)).map(group => `${group}:\n${groups.get(group)!.join("\n")}`);
  return `Zhivex Harness — ${topic.replace(":", " ")}\n\nUsage: ${usage[topic]}\n` +
    (examples[topic] ? `\nExamples:\n${examples[topic].map(example => `  ${example}`).join("\n")}\n` : "") +
    `\n${sections.join("\n\n")}\n\nUse zhx help all for the full reference and exit codes.`;
}
