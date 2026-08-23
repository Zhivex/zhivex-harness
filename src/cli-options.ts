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
  "--json": ["--jsonl"],
  "--jsonl": ["--json"],
  "--session": ["--continue"],
  "--continue": ["--session"],
  "--approve": ["--deny"],
  "--deny": ["--approve"]
};

export const CLI_OPTION_NAMES = [
  "--provider", "--model", "--route", "--workspace", "--state-dir", "--mcp-config",
  "--context-config", "--no-project-context", "--patch", "--preconditions", "--now",
  "--execution", "--oci-runtime", "--oci-image", "--oci-allow-command", "--oci-shell",
  "--oci-max-process-runtime-ms", "--oci-max-process-output-bytes", "--oci-max-memory-mb",
  "--oci-max-pids", "--oci-max-cpus", "--oci-max-workspace-bytes", "--oci-max-file-write-bytes",
  "--oci-tmpfs-mb", "--store", "--tenant", "--user", "--namespace", "--idempotency-key",
  "--max-steps", "--timeout-ms", "--max-tool-calls", "--max-tool-errors", "--max-input-tokens",
  "--max-output-tokens", "--max-total-tokens", "--subagent-max-steps", "--subagent-max-tool-calls",
  "--subagent-max-tool-errors", "--subagent-max-input-tokens", "--subagent-max-output-tokens",
  "--subagent-max-total-tokens", "--subagent-timeout-ms", "--max-parallel-reviews", "--max-cost-usd",
  "--input-cost-per-million", "--output-cost-per-million", "--allow-check", "--require-capability",
  "--subagent", "--reviewer", "--yes", "--approve", "--deny", "--json", "--jsonl", "--session",
  "--continue", "--status", "--limit", "--cursor", "--before", "--reason", "--cascade", "--final",
  "--apply", "--help", "--version"
] as const;

export type CliOptionName = (typeof CLI_OPTION_NAMES)[number];

export const CLI_OPTION_DEFINITIONS: Readonly<Record<CliOptionName, CliOptionDefinition>> =
  Object.fromEntries(CLI_OPTION_NAMES.map((name) => [name, {
    repeatable: repeatableOptions.has(name),
    conflictsWith: conflicts[name] ?? []
  }])) as Readonly<Record<CliOptionName, CliOptionDefinition>>;

const locator = ["--workspace", "--state-dir", "--store", "--tenant", "--user", "--namespace"] as const;
const provider = ["--provider", "--model"] as const;
const project = ["--mcp-config", "--context-config", "--no-project-context"] as const;
const execution = [
  "--execution", "--oci-runtime", "--oci-image", "--oci-allow-command", "--oci-shell",
  "--oci-max-process-runtime-ms", "--oci-max-process-output-bytes", "--oci-max-memory-mb",
  "--oci-max-pids", "--oci-max-cpus", "--oci-max-workspace-bytes", "--oci-max-file-write-bytes",
  "--oci-tmpfs-mb"
] as const;
const budgets = [
  "--max-steps", "--timeout-ms", "--max-tool-calls", "--max-tool-errors", "--max-input-tokens",
  "--max-output-tokens", "--max-total-tokens", "--max-cost-usd", "--input-cost-per-million",
  "--output-cost-per-million", "--subagent-max-steps", "--subagent-max-tool-calls",
  "--subagent-max-tool-errors", "--subagent-max-input-tokens", "--subagent-max-output-tokens",
  "--subagent-max-total-tokens", "--subagent-timeout-ms"
] as const;
const childBudgets = [
  "--subagent-max-steps", "--subagent-max-tool-calls", "--subagent-max-tool-errors",
  "--subagent-max-input-tokens", "--subagent-max-output-tokens", "--subagent-max-total-tokens",
  "--subagent-timeout-ms"
] as const;
const agent = [
  ...provider, "--route", ...locator, ...project, ...execution, ...budgets, "--allow-check",
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
  run: contract([...agent, "--idempotency-key", "--yes", "--json", "--jsonl"]),
  review: contract([
    ...provider, "--route", ...locator, "--context-config", "--no-project-context",
    ...childBudgets, "--max-parallel-reviews", "--require-capability", "--reviewer", "--json"
  ]),
  chat: contract([...agent, "--yes", "--session", "--continue"]),
  providers: contract(["--json"]),
  doctor: contract([...provider, ...locator, ...project, ...execution, ...budgets, "--allow-check", "--require-capability", "--subagent", "--json"]),
  resume: contract([...locator, "--approve", "--deny", "--json", "--jsonl"], [["--approve", "--deny"]]),
  "runs:list": contract([...locator, "--status", "--limit", "--cursor", "--json"]),
  "runs:inspect": contract([...locator, "--json"]),
  "runs:cancel": contract([...locator, "--reason", "--cascade", "--final", "--json"]),
  "runs:cleanup": contract([...locator, "--before", "--status", "--limit", "--json"], ["--before"]),
  "runs:export": contract([...locator, "--json"]),
  "sessions:list": contract([...locator, "--limit", "--json"]),
  "sessions:inspect": contract([...locator, "--json"]),
  "sessions:rename": contract([...locator, "--json"]),
  "sessions:fork": contract([...locator, "--json"]),
  "sessions:archive": contract([...locator, "--json"]),
  "changes:create": contract(["--patch"], ["--patch"]),
  "changes:verify": contract(["--patch", "--preconditions", "--now"], ["--patch"]),
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
