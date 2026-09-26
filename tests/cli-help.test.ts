import { expect, test } from "bun:test";
import { parseCliArgs, CLI_FULL_HELP_TEXT } from "../src/cli.js";
import { formatCliHelp } from "../src/cli/cli-help.js";
import { formatConsoleHelp, searchConsoleCommands } from "../src/cli/console/console-commands.js";

test("help routes without requiring task arguments, state access or approvals", () => {
  for (const [args, topic] of [
    [["--help"], undefined], [["help"], undefined], [["help", "all"], "all"],
    [["run", "--help"], "run"], [["help", "run"], "run"],
    [["resume", "-h"], "resume"], [["runs", "cleanup", "--help"], "runs:cleanup"],
    [["state", "import", "--help"], "state:import"], [["help", "sessions", "list"], "sessions:list"],
  ] as const) {
    const parsed = parseCliArgs([...args]);
    expect(parsed.command).toBe("help");
    expect(parsed.helpTopic).toBe(topic);
  }
  expect(() => parseCliArgs(["help", "missing"])).toThrow("Unknown help topic");
  expect(() => parseCliArgs(["help", "__proto__"])).toThrow();
  expect(() => parseCliArgs(["runs", "missing", "--help"])).toThrow("Unknown help topic");
  expect(() => parseCliArgs(["help", "--json"])).toThrow("not supported");
  expect(() => parseCliArgs(["state", "import"])).toThrow();
  expect(() => parseCliArgs(["resume", "run_1"])).toThrow();
});

test("short help leads to focused help without exposing unrelated options", () => {
  const short = formatCliHelp(undefined, "test", CLI_FULL_HELP_TEXT);
  expect(short.split("\n").length).toBeLessThan(25);
  expect(short).not.toContain("--oci-max");
  expect(short).toContain("zhx help all");
  const listing = formatCliHelp("sessions:list", "test", CLI_FULL_HELP_TEXT);
  expect(listing).toContain("--search");
  expect(listing).not.toContain("--provider");
  expect(listing).not.toContain("--approve");
  expect(formatCliHelp("resume", "test", CLI_FULL_HELP_TEXT)).toContain("--deny");
  expect(formatCliHelp("state", "test", CLI_FULL_HELP_TEXT)).toContain("zhx state import");
  expect(formatCliHelp("all", "test", CLI_FULL_HELP_TEXT)).toContain("--oci-max-memory-mb");
  expect(CLI_FULL_HELP_TEXT).not.toContain("--agent-profile");
  expect(formatCliHelp("run", "test", CLI_FULL_HELP_TEXT)).toContain("--require-verified-delivery");
  expect(formatCliHelp("run", "test", CLI_FULL_HELP_TEXT)).toContain("--profile");
});

test("common actions stay small while advanced and safety actions remain discoverable", () => {
  expect(searchConsoleCommands("/").length).toBeLessThan(10);
  expect(searchConsoleCommands("/").map(([name]) => name)).not.toContain("/route");
  expect(searchConsoleCommands("/route").map(([name]) => name)).toContain("/route");
  expect(formatConsoleHelp()).not.toContain("/route");
  for (const name of ["/pending", "/approve", "/deny"]) expect(formatConsoleHelp()).toContain(name);
  expect(formatConsoleHelp("direct", true)).toContain("/route");
  expect(formatConsoleHelp("service", true)).not.toContain("/model");
  expect(searchConsoleCommands("/route", "service")).toHaveLength(0);
});
