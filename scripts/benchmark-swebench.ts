import path from "node:path";

const [action, ...args] = process.argv.slice(2);
const scripts: Record<string, string> = { prepare: "prepare.py", preflight: "preflight.py", run: "run.py", report: "report.py", test: "test_contracts.py" };
if (!action || !scripts[action]) throw new Error("Usage: benchmark-swebench.ts prepare|preflight|run|report|test [arguments]");
const child = Bun.spawn([process.env.ZHIVEX_SWEBENCH_PYTHON ?? "python3", path.join(import.meta.dir, "swebench", scripts[action]!), ...args], {
  stdin: "inherit", stdout: "inherit", stderr: "inherit", env: { ...process.env, BUN_EXECUTABLE: process.execPath }
});
process.exitCode = await child.exited;
