import { parseCliArgs as core } from "../packages/core/src/cli/arguments.js";
import { parseCliArgs as code } from "../packages/core/src/compat/cli.js";

// Read-only parser probes. No launcher, profile resolution or service is invoked.
const cases: { id: string; argv: string[] }[] = [
  { id: "empty", argv: [] },
  { id: "implicit-task", argv: ["inspect fixture"] },
  { id: "help-alias", argv: ["-h"] },
  { id: "version-alias", argv: ["-v"] },
  { id: "help-bypasses-invalid-provider", argv: ["run", "--provider", "invalid", "--help"] },
  { id: "literal-separator", argv: ["run", "--", "--help"] },
  { id: "equals-value", argv: ["run", "--model=custom=model", "task"] },
  { id: "stdin-task", argv: ["run", "-"] },
  { id: "stdin-mixed-rejected", argv: ["run", "-", "extra"] },
  { id: "json-jsonl-conflict", argv: ["run", "task", "--json", "--jsonl"] },
  { id: "implicit-continue", argv: ["--continue"] },
  { id: "auto-approve", argv: ["run", "task", "--auto-approve"] },
  { id: "auto-approve-manual", argv: ["run", "task", "--auto-approve", "manual"] },
  { id: "application-status", argv: ["application", "status", "--json"] },
  { id: "application-stop-without-review", argv: ["application", "stop"] },
  { id: "agent-tools-stdin", argv: ["agents", "tools", "-"] },
  { id: "provider-config-stdin", argv: ["connections", "configure", "-"] },
  { id: "project-context", argv: ["projects", "context", "--json"] },
  { id: "automation-apply", argv: ["automations", "apply", "-", "--yes"] },
  { id: "personal-notes-default-offset", argv: ["personal", "notes"] },
];
const observe = (parser: typeof core | typeof code, argv: string[]) => {
  try { return { accepted: true, options: parser(argv) }; }
  catch (error) { return { accepted: false, error: error instanceof Error ? error.message : String(error) }; }
};
console.log(JSON.stringify({ schemaVersion: 1,
  cases: cases.map(({ id, argv }) => {
    const a = observe(core, argv), b = observe(code, argv);
    return { id, argv, core: a, code: b, equal: JSON.stringify(a) === JSON.stringify(b) };
  }), limitations: ["Observed parser behavior only, not installed executable parity", "Runtime defaults, stdin reads, output streams and exit codes require process tests", "Inputs are synthetic; no personal configuration or network accessed"]
}, null, 2));
