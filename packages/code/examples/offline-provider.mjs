// Tutorial-only preload. Replaces fetch completely: no request can leave this process.
import { appendFileSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { createHash, randomUUID } from "node:crypto";
import path from "node:path";

const workspace = process.env.CODE_TUTORIAL_WORKSPACE;
if (!workspace) throw new Error("Run this fixture through first-use.mjs.");
const statePath = path.join(workspace, ".tutorial-provider.json");
const state = existsSync(statePath) ? JSON.parse(readFileSync(statePath, "utf8")) : {};
let task = state.task ?? "";
globalThis.fetch = async (url, options = {}) => {
  if (!String(url).startsWith("https://api.openai.com/v1/responses")) throw new Error("Offline tutorial blocked an unexpected endpoint.");
  const body = JSON.parse(options.body);
  appendFileSync(path.join(workspace, ".tutorial-requests.jsonl"), JSON.stringify(body) + "\n");
  const users = (Array.isArray(body.input) ? body.input : []).filter(item => item.role === "user");
  if (users.length) {
    const incoming = JSON.stringify(users.at(-1).content);
    if (incoming !== task && /Operator task goal:/i.test(incoming)) state.checked = false;
    task = incoming; state.task = task;
  }
  const guided = /Operator task goal:/i.test(task);
  const id = `tutorial_${randomUUID()}`;
  let abort;
  return new Response(new ReadableStream({
    start(controller) {
      const send = event => controller.enqueue(new TextEncoder().encode(`data: ${JSON.stringify(event)}\n\n`));
      const text = delta => send({ type: "response.output_text.delta", delta });
      const tool = (name, args) => send({ type: "response.output_item.done", item: {
        type: "function_call", status: "completed", id: `fc_${id}`, call_id: `call_${id}`, name, arguments: JSON.stringify(args),
      } });
      if (/Interrupt fixture/i.test(task) && !state.interrupted) {
        state.interrupted = true; writeFileSync(statePath, JSON.stringify(state));
        text("Offline task is waiting; press Ctrl+C now.");
        abort = () => controller.error(new DOMException("Tutorial interrupted", "AbortError"));
        options.signal?.addEventListener("abort", abort, { once: true });
        if (options.signal?.aborted) abort();
        return;
      }
      if (/Fix greeting/i.test(task) && !state.edited) {
        state.edited = true;
        const before = readFileSync(path.join(workspace, "greeting.mjs"), "utf8");
        tool("apply_reviewed_edits", { changes: [{ path: "greeting.mjs",
          expectedDigest: `sha256:${createHash("sha256").update(before).digest("hex")}`,
          content: 'export const greeting = (name) => `Hello, ${name}!`;\n' }] });
      } else if ((guided || /Check greeting/i.test(task) || /Continue the previous unfinished task/i.test(task)) && !state.checked) {
        state.checked = true;
        tool("run_check", { check: "test", expectedScript: "node --test greeting.test.mjs" });
      } else text(guided ? "Offline guided task finished. Inspect task evidence; human review is still required."
        : /Fix greeting/i.test(task) ? "Offline edit task finished. Use Check greeting to verify the result."
        : /Check greeting/i.test(task) || /Continue the previous unfinished task/i.test(task) ? "Offline check task finished. Inspect the recorded check receipt."
        : "Offline fixture ready. Capture greeting.mjs, then ask Fix greeting.");
      writeFileSync(statePath, JSON.stringify(state));
      send({ type: "response.completed", response: { id: `resp_${id}`, status: "completed",
        usage: { input_tokens: 20, output_tokens: 5, total_tokens: 25 } } });
      controller.close();
    },
    cancel() { if (abort) options.signal?.removeEventListener("abort", abort); },
  }), { headers: { "content-type": "text/event-stream" } });
};
