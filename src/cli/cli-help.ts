import { CLI_COMMAND_OPTION_CONTRACTS, type CliCommandOptionContractKey } from "./cli-options.js";

const usage: Record<string, string> = {
  init: "zhx init [--provider <id>] [--model <id>] [--profile <name>]",
  run: 'zhx run [options] "task"', review: 'zhx review [options] "review task"',
  chat: "zhx [--continue | --session <id>]", providers: "zhx providers [--json]",
  doctor: "zhx doctor [options]", resume: "zhx resume <runId> --approve|--deny",
  "runs:list": "zhx runs list [options]", "runs:inspect": "zhx runs inspect <runId>",
  "runs:cancel": "zhx runs cancel <runId> [options]", "runs:cleanup": "zhx runs cleanup --before <date> [options]",
  "runs:export": "zhx runs export <runId>", "sessions:list": "zhx sessions list [--search <text>]",
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
    "--usage-limit-usd": "  --usage-limit-usd <amount>    Per-run monetary limit; requires pricing",
    "--version": "  --version                     Show the installed version",
  };
  const lines = contract.allowed.map(name => descriptions.get(name) ?? extra[name] ?? `  ${name}`);
  return `Zhivex Harness — ${topic.replace(":", " ")}\n\nUsage: ${usage[topic]}\n\nOptions:\n${lines.join("\n")}\n\nUse zhx help all for the full reference and exit codes.`;
}
