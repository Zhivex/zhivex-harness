import { expect, test } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { runPortableProcess } from "../src/execution/process-runtime.js";

for (const cancellation of ["timeout", "abort"] as const) {
  test.skipIf(process.platform === "win32")(`${cancellation} kills descendants with ignored output and resistant SIGTERM handlers`, async () => {
    const root = await mkdtemp(path.join(tmpdir(), "harness-process-group-"));
    const marker = path.join(root, "heartbeat");
    const childSource = `const fs=require('node:fs');process.on('SIGTERM',()=>{});
      const tick=()=>fs.writeFileSync(${JSON.stringify(marker)},JSON.stringify({pid:process.pid,at:Date.now()}));
      tick();setInterval(tick,20);`;
    const parentSource = `require('node:child_process').spawn(process.execPath,['-e',${JSON.stringify(childSource)}],{stdio:'ignore'});setInterval(()=>{},1000);`;
    const controller = new AbortController();
    let childPid: number | undefined;
    const pending = runPortableProcess([process.execPath, "-e", parentSource], {
      timeoutMs: cancellation === "timeout" ? 1500 : 5000, signal: controller.signal
    }).then(result => ({ result }), error => ({ error }));
    try {
      const deadline = Date.now() + 4000;
      while (childPid === undefined && Date.now() < deadline) {
        try { childPid = JSON.parse(await readFile(marker, "utf8")).pid; } catch { /* Wait for child readiness. */ }
        if (childPid === undefined) await new Promise(resolve => setTimeout(resolve, 10));
      }
      expect(childPid).toBeNumber();
      if (cancellation === "abort") controller.abort();
      const outcome = await pending;
      if (cancellation === "timeout") expect(outcome).toMatchObject({ result: { timedOut: true } });
      else expect(outcome).toMatchObject({ error: { name: "AbortError" } });
      // An exited orphan may briefly remain a zombie; checking its heartbeat proves
      // it stopped executing without depending on the host's reaping schedule.
      await new Promise(resolve => setTimeout(resolve, 100));
      const stopped = await readFile(marker, "utf8");
      await new Promise(resolve => setTimeout(resolve, 150));
      expect(await readFile(marker, "utf8")).toBe(stopped);
    } finally {
      controller.abort();
      await pending;
      if (childPid !== undefined) { try { process.kill(childPid, "SIGKILL"); } catch { /* Already terminated. */ } }
      await rm(root, { recursive: true, force: true });
    }
  }, 8000);
}

test.skipIf(process.platform === "win32")("leader exit preserves the descendant cleanup grace period", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "harness-process-cleanup-"));
  const ready = path.join(root, "ready");
  const cleaned = path.join(root, "cleaned");
  const childSource = `const fs=require('node:fs');
    process.on('SIGTERM',()=>setTimeout(()=>{fs.writeFileSync(${JSON.stringify(cleaned)},'complete');process.exit(0)},100));
    fs.writeFileSync(${JSON.stringify(ready)},String(process.pid));setInterval(()=>{},1000);`;
  const parentSource = `require('node:child_process').spawn(process.execPath,['-e',${JSON.stringify(childSource)}],{stdio:'ignore'});setInterval(()=>{},1000);`;
  const controller = new AbortController();
  let childPid: number | undefined;
  const pending = runPortableProcess([process.execPath, "-e", parentSource], { timeoutMs: 5000, signal: controller.signal })
    .then(result => ({ result }), error => ({ error }));
  try {
    const deadline = Date.now() + 4000;
    while (childPid === undefined && Date.now() < deadline) {
      try { childPid = Number(await readFile(ready, "utf8")); } catch { /* Wait for handler installation. */ }
      if (childPid === undefined) await new Promise(resolve => setTimeout(resolve, 10));
    }
    expect(childPid).toBeNumber();
    controller.abort();
    expect(await pending).toMatchObject({ error: { name: "AbortError" } });
    expect(await readFile(cleaned, "utf8")).toBe("complete");
  } finally {
    controller.abort();
    await pending;
    if (childPid !== undefined) { try { process.kill(childPid, "SIGKILL"); } catch { /* Already terminated. */ } }
    await rm(root, { recursive: true, force: true });
  }
}, 8000);
