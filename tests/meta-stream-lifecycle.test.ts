import { expect, test } from "bun:test";
import { spawn } from "node:child_process";

// Exercise the shipped SDK adapter, not a mock model: its setup failure used to
// leave a timeout alive after the caller had received the HTTP error.
for (const scenario of ["503", "504", "network", "complete", "return", "stream-error", "caller-abort", "deadline", "stream-abort", "stream-deadline"] as const) {
  test(`Meta stream releases its deadline after ${scenario}`, async () => {
    const modulePath = new URL("../src/providers/meta-replay.ts", import.meta.url).pathname;
    const source = `
      import assert from "node:assert/strict";
      import { createMetaReplayModel } from ${JSON.stringify(modulePath)};
      const scenario = ${JSON.stringify(scenario)};
      const caller = new AbortController();
      let signal;
      const fetcher = Object.assign(async (_url, init) => {
        signal = init.signal;
        if (scenario === "503" || scenario === "504") return Response.json({ error: { type: "server_error", message: "fixture" } }, { status: Number(scenario) });
        if (scenario === "network") throw new TypeError("fixture transport failure");
        if (scenario === "caller-abort" || scenario === "deadline") {
          const pending = new Promise((_, reject) => signal.addEventListener("abort", () => reject(signal.reason), { once: true }));
          if (scenario === "caller-abort") queueMicrotask(() => caller.abort(new Error("fixture cancellation")));
          return pending;
        }
        if (scenario === "stream-abort" || scenario === "stream-deadline") {
          return new Response(new ReadableStream({ start(controller) {
            signal.addEventListener("abort", () => controller.error(signal.reason), { once: true });
            if (scenario === "stream-abort") queueMicrotask(() => caller.abort(new Error("fixture cancellation")));
          } }));
        }
        if (scenario === "stream-error") return new Response("data: invalid-json\\n\\n");
        return new Response('data: {"type":"response.completed","response":{"id":"fixture","status":"completed","output":[]}}\\n\\n');
      }, { preconnect: fetch.preconnect });
      const model = createMetaReplayModel({ apiKey: "fixture", fetch: fetcher }, "muse-spark-1.3");
      let failed = false;
      try {
        const stream = await model.stream({ messages: [{ role: "user", parts: [{ type: "text", text: "fixture" }] }], maxRetries: 0,
          timeoutMs: scenario.endsWith("deadline") ? 40 : 60000, abortSignal: caller.signal });
        if (scenario === "return") await stream[Symbol.asyncIterator]().return();
        else for await (const event of stream) {}
      } catch (error) {
        failed = true;
        if (scenario === "503" || scenario === "504") assert.equal(error.status, Number(scenario));
        if (["caller-abort", "stream-abort"].includes(scenario)) assert.equal(error.message, "fixture cancellation");
        if (scenario.endsWith("deadline")) assert.equal(error.name, "TimeoutError");
      }
      assert.equal(failed, !["complete", "return"].includes(scenario));
      if (["caller-abort", "deadline", "stream-abort", "stream-deadline"].includes(scenario)) assert.equal(signal.aborted, true);
      console.log("settled");
    `;
    const child = spawn(process.execPath, ["--eval", source], { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "", stderr = "", timedOut = false;
    child.stdout.on("data", value => stdout += value);
    child.stderr.on("data", value => stderr += value);
    const timer = setTimeout(() => { timedOut = true; child.kill("SIGKILL"); }, 2500);
    try {
      const code = await new Promise<number | null>((resolve, reject) => { child.once("close", resolve); child.once("error", reject); });
      expect(stdout).toContain("settled");
      expect({ code, timedOut, stderr }).toEqual({ code: 0, timedOut: false, stderr: "" });
    } finally { clearTimeout(timer); if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL"); }
  });
}
