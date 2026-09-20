import { expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Workspace } from "../src/workspace.js";
import { createEditProposal } from "../src/edit-contracts.js";
import { withWorkspaceMutation } from "../src/workspace-mutation-lock.js";

test("only one concurrent update may consume a shared baseline digest", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "workspace-cas-"));
  try {
    await writeFile(path.join(root, "value.txt"), "before");
    const writers = await Promise.all([Workspace.open(root), Workspace.open(root)]);
    const { digest } = await writers[0]!.readFile("value.txt");
    const results = await Promise.allSettled(writers.map((writer, index) => {
      const changes = [{ path: "value.txt", expectedDigest: digest, content: `writer-${index}` }];
      return writer.applyPatch({ proposalId: createEditProposal({ changes }).proposalId, changes });
    }));
    expect(results.filter(result => result.status === "fulfilled")).toHaveLength(1);
    expect(results.filter(result => result.status === "rejected")).toHaveLength(1);
    expect((results.find(result => result.status === "rejected") as PromiseRejectedResult).reason.message).toContain("Stale patch");
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("workspace mutation ownership excludes another process and recovers after owner death", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "workspace-lock-crash-"));
  const modulePath = path.resolve(import.meta.dir, "../src/workspace-mutation-lock.ts");
  const source = `import {withWorkspaceMutation} from ${JSON.stringify(modulePath)};
    await withWorkspaceMutation(${JSON.stringify(root)}, async () => {
      console.log("OWNED"); await new Promise(resolve => setTimeout(resolve, 60000));
    });`;
  const child = Bun.spawn([process.execPath, "-e", source], { stdout: "pipe", stderr: "pipe" });
  try {
    const reader = child.stdout.getReader();
    const ready = await reader.read();
    expect(new TextDecoder().decode(ready.value)).toContain("OWNED");
    reader.releaseLock();
    let entered = false;
    const contender = withWorkspaceMutation(root, async () => { entered = true; });
    await new Promise(resolve => setTimeout(resolve, 100));
    expect(entered).toBe(false);
    child.kill("SIGKILL");
    await child.exited;
    await contender;
    expect(entered).toBe(true);
  } finally {
    child.kill("SIGKILL");
    await child.exited;
    await rm(root, { recursive: true, force: true });
  }
}, 10_000);

test("nested import transactions retain ownership until rollback finishes", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "workspace-lock-nested-"));
  try {
    await writeFile(path.join(root, "value.txt"), "before");
    const workspace = await Workspace.open(root);
    await withWorkspaceMutation(workspace.root, async () => {
      const { digest } = await workspace.readFile("value.txt");
      const changes = [{ path: "value.txt", expectedDigest: digest, content: "after" }];
      await workspace.applyPatch({ proposalId: createEditProposal({ changes }).proposalId, changes });
    });
    expect(await readFile(path.join(root, "value.txt"), "utf8")).toBe("after");
  } finally { await rm(root, { recursive: true, force: true }); }
});
