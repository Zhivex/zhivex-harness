import { expect, test } from "bun:test";
import { spawn } from "node:child_process";
import path from "node:path";
import { benchmarkProgressSchema, sanitizedErrorDetails } from "../src/runtime/error-diagnostics.js";

test("driver checkpoints track phases and events without event payloads", async () => {
  const module = path.resolve(import.meta.dir, "../scripts/time-to-safe-fix-progress.ts");
  const child = spawn(process.execPath, ["-e", `import { reportBenchmarkProgress as p } from ${JSON.stringify(module)};
    p("harness_create"); p("agent_run", "agent-step-start"); p("agent_run", "tool-call");
    p("agent_run", "tool-result"); p("agent_run", "secret-payload"); p("verification");`],
    { env: { ...process.env, ZHIVEX_BENCHMARK_PROGRESS: "1" }, stdio: ["ignore", "pipe", "pipe", "pipe"] });
  let output = "";
  child.stdio[3]!.on("data", chunk => output += chunk.toString());
  expect(await new Promise<number | null>((resolve, reject) => { child.on("close", resolve); child.on("error", reject); })).toBe(0);
  const rows = output.trim().split("\n").map(row => benchmarkProgressSchema.parse(JSON.parse(row)));
  expect(rows.at(-1)).toMatchObject({ phase: "verification", lastEvent: "none", steps: 1, toolCalls: 1, toolResults: 1 });
  expect(rows[3]).toMatchObject({ phase: "agent_run", lastEvent: "tool-result" });
  expect(output).not.toContain("secret");
  expect(sanitizedErrorDetails({ benchmarkProgress: { ...rows[0], prompt: "secret" } }).benchmarkProgress).toBeUndefined();
  expect(sanitizedErrorDetails({ benchmarkProgress: rows[0] }).benchmarkProgress).toEqual(rows[0]);
});


test("built-in driver leaves cleanup time inside the unchanged supervisor budget", async () => {
  const { parseOptions } = await import("../scripts/benchmark-time-to-safe-fix.js");
  for (const budget of [2000, 10000, 300000]) {
    const options = parseOptions(["--driver-zhivex", "--driver-timeout-ms", String(budget)]);
    const index = options.driverArgs.indexOf("--timeout-ms");
    expect(index).toBeGreaterThanOrEqual(0);
    const execution = Number(options.driverArgs[index + 1]);
    expect(execution).toBeGreaterThanOrEqual(1000);
    expect(execution).toBeLessThan(budget);
    expect(budget - execution).toBeLessThanOrEqual(30000);
    expect(options.driverTimeoutMs).toBe(budget);
  }
  expect(() => parseOptions(["--driver-zhivex", "--driver-timeout-ms", "1999"])).toThrow("at least 2000ms");
});
