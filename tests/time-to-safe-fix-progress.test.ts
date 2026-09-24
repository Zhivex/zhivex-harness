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

test.each([false, true])("exit observation does not keep a child alive, retained timer=%s", async retained => {
  const module = path.resolve(import.meta.dir, "../scripts/time-to-safe-fix-progress.ts");
  const child = spawn(process.execPath, ["-e", `import { reportBenchmarkResources as r, startBenchmarkExitObservation as observe } from ${JSON.stringify(module)};
    r("cleanup"); r("cleanup_complete"); r("result_write");
    ${retained ? "setTimeout(() => {}, 1300);" : ""}
    observe();`], {env:{...process.env,ZHIVEX_BENCHMARK_PROGRESS:"1"},stdio:["ignore","pipe","pipe","pipe"]});
  let output = "";
  child.stdio[3]!.on("data", chunk => output += chunk.toString());
  const watchdog = setTimeout(() => child.kill("SIGKILL"), 4000);
  try {
    expect(await new Promise<number | null>(resolve => child.once("close", resolve))).toBe(0);
    const rows = output.trim().split("\n").map(row => benchmarkProgressSchema.parse(JSON.parse(row)));
    expect(rows.map(row => row.phase)).toEqual(["cleanup","cleanup_complete","result_write","result_written",...(retained ? ["exit_pending" as const] : [])]);
    expect(rows.at(-1)?.resourceObservation).toBe(process.versions.bun ? "unsupported" : "node");
  } finally { clearTimeout(watchdog); child.kill(); }
});

test("Node exit diagnostics identify a referenced timer without exposing handle contents", async () => {
  const { mkdtemp, writeFile, rm } = await import("node:fs/promises");
  const os = await import("node:os");
  const directory = await mkdtemp(path.join(os.tmpdir(), "harness-exit-observer-"));
  try {
    const entry = path.join(directory,"entry.ts");
    await writeFile(entry, `import {startBenchmarkExitObservation} from ${JSON.stringify(path.resolve(import.meta.dir,"../scripts/time-to-safe-fix-progress.ts"))}; setTimeout(()=>{},1300); startBenchmarkExitObservation();`);
    const build = await Bun.build({entrypoints:[entry],outdir:directory,target:"node"});
    expect(build.success).toBe(true);
    const child = spawn("node",[path.join(directory,"entry.js")],{env:{...process.env,ZHIVEX_BENCHMARK_PROGRESS:"1"},stdio:["ignore","pipe","pipe","pipe"]});
    let output="";
    child.stdio[3]!.on("data",chunk=>output+=chunk.toString());
    const watchdog=setTimeout(()=>child.kill("SIGKILL"),4000);
    try {
      expect(await new Promise<number|null>((resolve,reject)=>{child.once("close",resolve);child.once("error",reject);})).toBe(0);
      const rows=output.trim().split("\n").map(row=>benchmarkProgressSchema.parse(JSON.parse(row)));
      expect(rows.at(-1)).toMatchObject({phase:"exit_pending",resourceObservation:"node",resources:expect.arrayContaining([{type:"Timeout",count:1}])});
    } finally {clearTimeout(watchdog);child.kill();}
  } finally {await rm(directory,{recursive:true,force:true});}
});
