import { describe, expect, test } from "bun:test";

import { parseCliArgs } from "../src/cli.js";

describe("CLI parsing", () => {
  test("parses one-shot provider and workspace options", () => {
    expect(parseCliArgs([
      "run",
      "--provider",
      "qwen",
      "--model",
      "qwen3.8-max",
      "--workspace",
      "/tmp/repo",
      "--max-steps",
      "8",
      "fix",
      "the tests"
    ])).toMatchObject({
      command: "run",
      provider: "qwen",
      model: "qwen3.8-max",
      workspace: "/tmp/repo",
      maxSteps: 8,
      prompt: "fix the tests"
    });
  });

  test("supports implicit run and resume decisions", () => {
    expect(parseCliArgs(["explain", "the repo"]).prompt).toBe("explain the repo");
    expect(parseCliArgs(["resume", "run-1", "--approve"])).toMatchObject({
      command: "resume",
      runId: "run-1",
      approve: true
    });
  });

  test("rejects ambiguous or unknown options", () => {
    expect(() => parseCliArgs(["resume", "run-1", "--approve", "--deny"])).toThrow("combine");
    expect(() => parseCliArgs(["run", "--wat"])).toThrow("Unknown option");
  });
});
