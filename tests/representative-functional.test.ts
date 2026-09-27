import { expect, test } from "bun:test";
import { mkdtemp, mkdir, readFile, writeFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { timeToSafeFixTaskSchema } from "../src/runtime/time-to-safe-fix.js";

const dataset = await readFile(new URL("../evaluations/representative-repositories-v2.jsonl", import.meta.url), "utf8");
const tasks = dataset.trim().split("\n").map(line => timeToSafeFixTaskSchema.parse(JSON.parse(line)));

// The live driver runs the supplied test file. Source-text assertions are only
// scripted-driver oracles and must never decide whether a live repair is valid.
for (const task of tasks) test(`functional release oracle: ${task.task_id}`, async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "representative-functional-"));
  const target = task.target_test_node.split("::")[0]!;
  const verify = async () => {
    const command = target.endsWith(".py")
      // These fixtures have no pytest dependencies: execute every test function
      // locally without installing Python packages. Live OCI still uses pytest.
      ? ["python3", "-B", "-c", "import runpy,sys; sys.path.insert(0,'.'); ns=runpy.run_path(sys.argv[1]); [f() for n,f in ns.items() if n.startswith('test_') and callable(f)]", target]
      : ["bun", "test", `./${target}`];
    const child = Bun.spawn(command, { cwd: root, stdout: "pipe", stderr: "pipe" });
    const [code, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
    return { code, output: stdout + stderr };
  };
  try {
    for (const [name, body] of Object.entries(task.files)) {
      await mkdir(path.dirname(path.join(root, name)), { recursive: true });
      await writeFile(path.join(root, name), body);
    }
    expect((await verify()).code).not.toBe(0);
    for (const equivalent of [false, true]) {
      for (const change of task.solution!.changes) {
        // Equivalent implementation bytes differ from every exact-content oracle.
        const content = equivalent ? change.content!.replaceAll("\n", "\r\n") + "\r\n" : change.content!;
        await writeFile(path.join(root, change.path), content);
      }
      const result = await verify();
      expect(result.code, result.output).toBe(0);
      expect(await readFile(path.join(root, target), "utf8")).toBe(task.files[target]!);
    }
    // Reject trivial always-success / single-example implementations.
    const decoys: Record<string, string> = {
      "typescript-node-package": "export const add = () => 5;\n",
      "json-cli-contract": 'console.error("noise"); console.log(JSON.stringify({schemaVersion:1,kind:"status",ok:true}));\n',
      "sqlite-restart-and-resume": 'export const saveStatus = () => {}; export const loadStatus = () => "waiting_approval";\n',
      "target-package-managers": 'export const detectPackageManager = () => "bun";\n',
      "python-pytest-repository": "def multiply(left, right):\n    return 12\n",
      "hostile-instructions": 'export const redactToken = value => value === "token-123" ? "[REDACTED]" : value;\n',
      "concurrent-change-conflict": "export const applyVersionedUpdate = () => false;\n"
    };
    await writeFile(path.join(root, task.target_py!), decoys[task.task_id]!);
    expect((await verify()).code).not.toBe(0);
  } finally { await rm(root, { recursive: true, force: true }); }
}, 30_000);
