import { describe, expect, test } from "bun:test";

import {
  CLI_COMMAND_OPTION_CONTRACTS,
  CLI_OPTION_DEFINITIONS,
  CLI_OPTION_NAMES
} from "../src/cli-options.js";
import { CliUsageError, parseCliArgs } from "../src/cli.js";

describe("command-specific CLI option contract", () => {
  test("declares allowed, required, repeatable, and conflict metadata for every command", () => {
    const declared = new Set<string>();
    for (const contract of Object.values(CLI_COMMAND_OPTION_CONTRACTS)) {
      expect(Array.isArray(contract.allowed)).toBe(true);
      expect(Array.isArray(contract.required)).toBe(true);
      expect(Array.isArray(contract.repeatable)).toBe(true);
      expect(contract.conflicts).toBeObject();
      for (const name of contract.allowed) {
        declared.add(name);
        expect(name in CLI_OPTION_DEFINITIONS).toBe(true);
        expect(contract.repeatable.includes(name)).toBe(CLI_OPTION_DEFINITIONS[name].repeatable);
      }
    }
    expect([...CLI_OPTION_NAMES].filter((name) => !declared.has(name))).toEqual([]);
  });

  test.each([
    [["run", "task", "--before", "1"], "run"],
    [["review", "task", "--jsonl"], "review"],
    [["review", "task", "--yes"], "review"],
    [["review", "task", "--idempotency-key", "request-1"], "review"],
    [["review", "task", "--max-steps", "1"], "review"],
    [["review", "task", "--execution", "oci"], "review"],
    [["review", "task", "--mcp-config", "mcp.json"], "review"],
    [["review", "task", "--allow-check", "test"], "review"],
    [["review", "task", "--subagent", "tester"], "review"],
    [["chat", "--json"], "chat"],
    [["chat", "--idempotency-key", "request-1"], "chat"],
    [["providers", "--provider", "openai"], "providers"],
    [["doctor", "--yes"], "doctor"],
    [["doctor", "--route", "reviewer=openai:gpt-test"], "doctor"],
    [["resume", "run-1", "--approve", "--model", "gpt-test"], "resume"],
    [["runs", "inspect", "run-1", "--status", "failed"], "runs inspect"],
    [["sessions", "inspect", "ses-1", "--before", "1"], "sessions inspect"],
    [["changes", "create", "input.json", "--patch", "change.patch", "--json"], "changes create"],
    [["version", "--json"], "version"],
    [["help", "--json"], "help"]
  ] as const)("rejects irrelevant options for %s", (argv, commandLabel) => {
    expect(() => parseCliArgs([...argv])).toThrow(CliUsageError);
    expect(() => parseCliArgs([...argv])).toThrow(
      argv.includes("--jsonl") ? "supported by run and resume" : `not supported by ${commandLabel}`
    );
  });

  test("rejects repeated scalar options while retaining declared repeatable options", () => {
    expect(() => parseCliArgs(["run", "--model", "a", "--model", "b", "task"]))
      .toThrow("--model cannot be repeated");
    expect(parseCliArgs(["runs", "list", "--status", "failed", "--status", "completed"]).statuses)
      .toEqual(["failed", "completed"]);
  });

  test("rejects review routes for profiles that the review group cannot execute", () => {
    expect(() => parseCliArgs(["review", "--route", "implementer=openai", "task"]))
      .toThrow("unused implementer profile");
  });

  test("enforces single and alternative required options from the manifest", () => {
    expect(() => parseCliArgs(["resume", "run-1"]))
      .toThrow("--approve or --deny is required by resume");
    expect(() => parseCliArgs(["runs", "cleanup"]))
      .toThrow("--before is required by runs cleanup");
    expect(() => parseCliArgs(["changes", "create", "input.json"]))
      .toThrow("--patch is required by changes create");
  });
});
