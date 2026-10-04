import { CLI_COMMAND_OPTION_CONTRACTS, type CliCommandOptionContractKey } from "./cli-options.js";

const usage: Record<string, string> = {
  "memory:remember": 'zhivex-code memory remember "content" [--source "provenance"]',
  "memory:suggest": 'zhivex-code memory suggest "content" [--source "provenance"]',
  "memory:list": 'zhivex-code memory list',
  "memory:read": 'zhivex-code memory read <id>',
  "memory:update": 'zhivex-code memory update <id> <revision> "content" [--source "provenance"]',
  "memory:forget": 'zhivex-code memory forget <id> <revision>',
  "memory:accept": 'zhivex-code memory accept <id> <reviewedRevision>',
  "memory:clear": 'zhivex-code memory clear',
  "memory:enable": 'zhivex-code memory enable',
  "memory:disable": 'zhivex-code memory disable',
  "memory:context": 'zhivex-code memory context "query"',
  init: "zhivex-code init [--provider <id>] [--model <id>] [--profile <name>] [--update]",
  run: 'zhivex-code run [options] "task" | zhivex-code run [options] -', review: 'zhivex-code review [options] "review task" | zhivex-code review [options] -',
  chat: "zhivex-code [--continue | --session <id>]", providers: "zhivex-code providers [--json]",
  doctor: "zhivex-code doctor [options]", resume: "zhivex-code resume <runId> --approve|--deny",
  "runs:list": "zhivex-code runs list [options]", "runs:inspect": "zhivex-code runs inspect <runId>",
  "runs:cancel": "zhivex-code runs cancel <runId> [options]", "runs:cleanup": "zhivex-code runs cleanup --before <date> [options]",
  "runs:export": "zhivex-code runs export <runId>", "sessions:list": "zhivex-code sessions list [--search <text>]",
  "sessions:inspect": "zhivex-code sessions inspect <sessionId>", "sessions:rename": 'zhivex-code sessions rename <sessionId> "title"',
  "sessions:fork": "zhivex-code sessions fork <sessionId>", "sessions:archive": "zhivex-code sessions archive <sessionId>",
  "changes:create": "zhivex-code changes create <input.json> --patch <artifact>",
  "changes:verify": "zhivex-code changes verify <envelope.json> --patch <artifact> [options]",
  "state:status": "zhivex-code state status", "state:export": "zhivex-code state export <backup.json>",
  "state:import": "zhivex-code state import <backup.json> [--apply]", version: "zhivex-code --version",
};

export const shortCliHelp = (version: string) => `Zhivex Code v${version}

Start in your project:
  zhivex-code                         Open the conversation (first-use setup if needed)
  zhivex-code --continue              Reopen the latest conversation
  zhivex-code run "task"              Run one task for a script or automation
  zhivex-code doctor                  Check local configuration

Inside the console, type / for common actions or /help for guidance.
  zhivex-code init                    Configure a provider/model profile explicitly
  zhivex-code <command> --help        Show help for one command
  zhivex-code help all                Show every command and advanced option
  zhivex-code --version               Show the installed version

Requires Node >=22.13. The console guides API key setup; automation uses environment keys.
Use zhivex-code chat to open the conversation explicitly.`;

export function resolveHelpTopic(parts: string[], explicit: boolean): string | undefined {
  if (!explicit || !parts.length) return undefined;
  const topic = parts.join(":");
  if (topic === "all" || Object.hasOwn(usage, topic) || Object.keys(usage).some(key => key.startsWith(`${topic}:`))) return topic;
  throw new Error(`Unknown help topic: ${parts.join(" ")}. Use zhivex-code help all.`);
}

export function formatCliHelp(topic: string | undefined, version: string, full: string): string {
  if (!topic) return shortCliHelp(version);
  if (topic === "all") return full;
  const contract = CLI_COMMAND_OPTION_CONTRACTS[topic as CliCommandOptionContractKey];
  if (!contract) {
    return `Zhivex Code — ${topic}\n\n` + Object.entries(usage)
      .filter(([key]) => key.startsWith(`${topic}:`)).map(([, command]) => `  ${command}`).join("\n") +
      `\n\nUse zhivex-code ${topic} <subcommand> --help for its options.`;
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
    "--usage-limit-usd": "  --usage-limit-usd <amount>    Per-run monetary limit; requires pricing",
    "--version": "  --version                     Show the installed version",
  };
  const examples: Record<string, string[]> = {
    run: ['zhivex-code run "Explain this repository"', 'zhivex-code run --profile daily --json "Review the parser"', 'git diff | zhivex-code run -'],
    review: ['zhivex-code review "Review error handling"', 'zhivex-code review - < review-task.txt'],
    init: ['zhivex-code init --profile daily', 'zhivex-code init --profile daily --update --model <id>'],
    doctor: ['zhivex-code doctor --profile daily', 'zhivex-code doctor --workspace /path/to/project'],
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
  return `Zhivex Code — ${topic.replace(":", " ")}\n\nUsage: ${usage[topic]}\n` +
    (examples[topic] ? `\nExamples:\n${examples[topic].map(example => `  ${example}`).join("\n")}\n` : "") +
    `\n${sections.join("\n\n")}\n\nUse zhivex-code help all for the full reference and exit codes.`;
}
