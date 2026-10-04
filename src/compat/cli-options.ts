export interface CliOptionDefinition {
  repeatable: boolean;
  conflictsWith: readonly string[];
}

export interface CliCommandOptionContract {
  allowed: readonly string[];
  required: readonly (string | readonly string[])[];
  repeatable: readonly string[];
  conflicts: Readonly<Record<string, readonly string[]>>;
}

const repeatableOptions = new Set([
  "--route",
  "--oci-allow-command",
  "--allow-check",
  "--require-capability",
  "--subagent",
  "--reviewer",
  "--status"
]);

const conflicts: Readonly<Record<string, readonly string[]>> = {
  "--approval-mode": ["--yes"],
  "--yes": ["--approval-mode"],
  "--token-budget": ["--no-token-budget"],
  "--no-token-budget": ["--token-budget"],
  "--usage-limit-usd": ["--max-cost-usd", "--input-cost-per-million", "--output-cost-per-million"],
  "--max-cost-usd": ["--usage-limit-usd"],
  "--input-cost-per-million": ["--usage-limit-usd"],
  "--output-cost-per-million": ["--usage-limit-usd"],
  "--json": ["--jsonl"],
  "--jsonl": ["--json"],
  "--session": ["--continue"],
  "--continue": ["--session"],
  "--approve": ["--deny"],
  "--deny": ["--approve"]
};

export const CLI_OPTION_NAMES = [
  "--compaction-model", "--compaction-provider",
  "--provider", "--model", "--reasoning", "--profile", "--route", "--workspace", "--state-dir", "--mcp-config",
  "--no-memory", "--source",
  "--context-config", "--no-project-context", "--patch", "--preconditions", "--now",
  "--require-verified-delivery", "--execution", "--oci-runtime", "--oci-image", "--oci-allow-command", "--oci-shell",
  "--oci-max-process-runtime-ms", "--oci-max-process-output-bytes", "--oci-max-memory-mb",
  "--oci-max-pids", "--oci-max-cpus", "--oci-max-workspace-bytes", "--oci-max-file-write-bytes",
  "--oci-tmpfs-mb", "--store", "--tenant", "--user", "--namespace", "--idempotency-key",
  "--token-budget", "--context-tokens", "--no-token-budget", "--max-steps", "--timeout-ms", "--max-tool-calls", "--max-tool-errors", "--max-input-tokens",
  "--max-output-tokens", "--max-total-tokens", "--subagent-max-steps", "--subagent-max-tool-calls",
  "--subagent-max-tool-errors", "--subagent-max-input-tokens", "--subagent-max-output-tokens",
  "--subagent-max-total-tokens", "--subagent-timeout-ms", "--max-parallel-reviews", "--max-cost-usd",
  "--input-cost-per-million", "--output-cost-per-million", "--allow-check", "--require-capability",
  "--subagent", "--reviewer", "--approval-mode", "--yes", "--approve", "--deny", "--json", "--jsonl", "--session",
  "--continue", "--update", "--status", "--limit", "--cursor", "--before", "--reason", "--cascade", "--final",
  "--service", "--apply", "--help", "--version", "--search", "--tool-policy", "--pricing-file", "--usage-limit-usd"
] as const;

export type CliOptionName = (typeof CLI_OPTION_NAMES)[number];

export const CLI_OPTION_DEFINITIONS: Readonly<Record<CliOptionName, CliOptionDefinition>> =
  Object.fromEntries(CLI_OPTION_NAMES.map((name) => [name, {
    repeatable: repeatableOptions.has(name),
    conflictsWith: conflicts[name] ?? []
  }])) as Readonly<Record<CliOptionName, CliOptionDefinition>>;

const locator = ["--workspace", "--state-dir", "--store", "--tenant", "--user", "--namespace"] as const;
const provider = ["--provider", "--model", "--reasoning"] as const;
const profile = ["--profile"] as const;
const project = ["--mcp-config", "--context-config", "--no-project-context"] as const;
const execution = [
  "--require-verified-delivery", "--execution", "--oci-runtime", "--oci-image", "--oci-allow-command", "--oci-shell",
  "--oci-max-process-runtime-ms", "--oci-max-process-output-bytes", "--oci-max-memory-mb",
  "--oci-max-pids", "--oci-max-cpus", "--oci-max-workspace-bytes", "--oci-max-file-write-bytes",
  "--oci-tmpfs-mb"
] as const;
const budgets = [
  "--token-budget", "--context-tokens", "--no-token-budget", "--max-steps", "--timeout-ms", "--max-tool-calls", "--max-tool-errors", "--max-input-tokens",
  "--max-output-tokens", "--max-total-tokens", "--max-cost-usd", "--input-cost-per-million",
  "--output-cost-per-million", "--subagent-max-steps", "--subagent-max-tool-calls",
  "--subagent-max-tool-errors", "--subagent-max-input-tokens", "--subagent-max-output-tokens",
  "--subagent-max-total-tokens", "--subagent-timeout-ms"
] as const;
const childBudgets = [
  "--no-token-budget",
  "--subagent-max-steps", "--subagent-max-tool-calls", "--subagent-max-tool-errors",
  "--subagent-max-input-tokens", "--subagent-max-output-tokens", "--subagent-max-total-tokens",
  "--subagent-timeout-ms"
] as const;
const agent = [
  "--no-memory",
  "--compaction-model", "--compaction-provider",
  "--tool-policy", "--pricing-file", "--usage-limit-usd",
  ...provider, ...profile, "--route", ...locator, ...project, ...execution, ...budgets, "--allow-check",
  "--require-capability", "--subagent"
] as const;

const contract = (
  allowed: readonly string[],
  required: readonly (string | readonly string[])[] = []
): CliCommandOptionContract => {
  const allowedSet = new Set(allowed);
  return {
    allowed,
    required,
    repeatable: allowed.filter((name) => repeatableOptions.has(name)),
    conflicts: Object.fromEntries(allowed.flatMap((name) => {
      const relevant = conflicts[name]?.filter((other) => allowedSet.has(other)) ?? [];
      return relevant.length > 0 ? [[name, relevant]] : [];
    }))
  };
};

export const CLI_COMMAND_OPTION_CONTRACTS = {
  init: contract([...provider, ...profile, "--update", "--json"]),
  run: contract(["--service", "--session", ...agent, "--idempotency-key", "--approval-mode", "--yes", "--json", "--jsonl"]),
  review: contract([
    "--tool-policy", "--pricing-file", "--usage-limit-usd",
    ...provider, ...profile, "--route", ...locator, "--context-config", "--no-project-context",
    ...childBudgets, "--max-parallel-reviews", "--require-capability", "--reviewer", "--json"
  ]),
  chat: contract(["--service", ...agent, "--approval-mode", "--yes", "--session", "--continue"]),
  providers: contract(["--json"]),
  policy: contract(["--service", ...agent, "--json"]),
  doctor: contract([...provider, ...profile, ...locator, ...project, ...execution, ...budgets, "--allow-check", "--require-capability", "--subagent", "--json"]),
  resume: contract(["--no-memory", "--tool-policy", "--service", "--session", ...locator, "--approve", "--deny", "--json", "--jsonl"], [["--approve", "--deny"]]),
  "runs:list": contract([...locator, "--status", "--limit", "--cursor", "--json"]),
  "runs:inspect": contract([...locator, "--json"]),
  "runs:cancel": contract([...locator, "--reason", "--cascade", "--final", "--json"]),
  "runs:cleanup": contract([...locator, "--before", "--status", "--limit", "--json"], ["--before"]),
  "runs:export": contract([...locator, "--json"]),
  "runs:report": contract([...locator, "--json", "--session"]),
  "sessions:list": contract(["--service", ...locator, "--limit", "--json", "--search"]),
  "sessions:inspect": contract(["--service", ...locator, "--json"]),
  "sessions:rename": contract(["--service", ...locator, "--json"]),
  "sessions:fork": contract([...locator, "--json"]),
  "sessions:archive": contract([...locator, "--json"]),
  "checkpoints:storage": contract([...locator, "--json"]),
  "checkpoints:prune-review": contract([...locator, "--json"]),
  "checkpoints:prune-apply": contract([...locator, "--json"]),
  "checkpoints:list": contract([...locator, "--json"]),
  "checkpoints:capture": contract([...locator, "--json"]),
  "checkpoints:inspect": contract([...locator, "--json"]),
  "checkpoints:prepare": contract([...locator, "--json"]),
  "checkpoints:review": contract([...locator, "--json"]),
  "checkpoints:apply": contract([...locator, "--json"]),
  "checkpoints:recover": contract([...locator, "--json"]),

  "changes:create": contract(["--patch"], ["--patch"]),
  "changes:verify": contract(["--patch", "--preconditions", "--now"], ["--patch"]),
  "memory:remember": contract([...locator, "--json", "--source"]),
  "memory:suggest": contract([...locator, "--json", "--source"]),
  "memory:list": contract([...locator, "--json"]),
  "memory:read": contract([...locator, "--json"]),
  "memory:update": contract([...locator, "--json", "--source"]),
  "memory:forget": contract([...locator, "--json"]),
  "memory:accept": contract([...locator, "--json"]),
  "memory:clear": contract([...locator, "--json"]),
  "memory:enable": contract([...locator, "--json"]),
  "memory:disable": contract([...locator, "--json"]),
  "memory:context": contract([...locator, "--json"]),
  "state:status": contract([...locator, "--json"]),
  "state:export": contract([...locator, "--json"]),
  "state:import": contract([...locator, "--apply", "--json"]),
  help: contract(["--help"]),
  version: contract(["--version"])
} as const satisfies Readonly<Record<string, CliCommandOptionContract>>;

export type CliCommandOptionContractKey = keyof typeof CLI_COMMAND_OPTION_CONTRACTS;

export const validateCliCommandOptions = (
  commandKey: CliCommandOptionContractKey,
  counts: ReadonlyMap<string, number>
) => {
  const commandContract = CLI_COMMAND_OPTION_CONTRACTS[commandKey];
  const allowed = new Set(commandContract.allowed);
  for (const [name, count] of counts) {
    if (!allowed.has(name)) {
      throw new Error(`${name} is not supported by ${commandKey.replace(":", " ")}.`);
    }
    if (count > 1 && !commandContract.repeatable.includes(name)) {
      throw new Error(`${name} cannot be repeated for ${commandKey.replace(":", " ")}.`);
    }
    for (const conflicting of commandContract.conflicts[name] ?? []) {
      if (counts.has(conflicting)) {
        throw new Error(`${name} cannot be combined with ${conflicting}.`);
      }
    }
  }
  for (const requirement of commandContract.required) {
    if (typeof requirement === "string") {
      if (!counts.has(requirement)) {
        throw new Error(`${requirement} is required by ${commandKey.replace(":", " ")}.`);
      }
      continue;
    }
    if (!requirement.some((name) => counts.has(name))) {
      throw new Error(
        `${requirement.join(" or ")} is required by ${commandKey.replace(":", " ")}.`
      );
    }
  }
};
