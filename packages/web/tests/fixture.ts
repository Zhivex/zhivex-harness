import { createHash } from "node:crypto";
import {
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile,
  symlink,
} from "node:fs/promises";
import { createHarness } from "@zhivex-ai/harness/engine";
import { createMockLanguageModel } from "@zhivex-ai/agents/testing";
import type { LanguageModel } from "@zhivex-ai/agents";
import type { JsonValue } from "@zhivex-ai/core";
import { attachRuntime } from "../src/runtime.js";
import { manageWebRuntime } from "../src/managed-runtime.js";
import { startWebServer } from "../src/server.js";

export async function fixture({ interactive = false }: { interactive?: boolean } = {}) {
  const root = await mkdtemp("/tmp/zcw-");
  const workspace = root + "/atlas";
  await mkdir(workspace);
  await writeFile(workspace + "/review.txt", "before\n");
  await writeFile(root + "/outside.txt", "outside-boundary-sentinel");
  await symlink(root + "/outside.txt", workspace + "/escape.txt");
  await writeFile(
    workspace + "/package.json",
    JSON.stringify({
      name: "atlas",
      scripts: { test: "node -e 'process.exit(7)'" },
    }),
  );
  const base = createMockLanguageModel();
  const model: LanguageModel = {
    ...base,
    async stream(input) {
      return (async function* () {
        const user = input.messages.findLastIndex((m) => m.role === "user");
        const prompt = JSON.stringify(input.messages[user]);
        const history = JSON.stringify(input.messages.slice(user + 1));
        if (prompt.includes("markdown-probe")) {
          yield {type:"text-delta" as const,textDelta:'## Short-term plan\n1. **Enable critical conformance gates**\n2. Verify `npm test`\n\n```js\nconst text = "<script>";\n```\n\n[Docs](https://example.com/docs)\n\n[execute](javascript:alert%281%29)\n\n![probe](https://attacker.invalid/track)\n\n<img src=x onerror=alert(1)>\n<script>alert(1)</script>'};
          yield {type:"finish" as const,finishReason:"stop" as const};return;
        }
        const call = (name: string, args: Record<string, JsonValue>) => ({
          type: "tool-call" as const,
          toolCall: { id: `${name}-${user}`, name, input: args },
        });
        if (prompt.includes("error-probe"))
          throw new Error(
            "Fixture provider failure sk-never-expose-fixturetoken",
          );
        if (
          prompt.includes("edit-probe") ||
          prompt.includes("boundary-probe") ||
          prompt.includes("symlink-probe")
        ) {
          const target = prompt.includes("symlink-probe")
            ? "escape.txt"
            : prompt.includes("boundary-probe")
              ? "../outside.txt"
              : "review.txt";
          if (!history.includes('"name":"read_file"')) {
            yield call("read_file", { path: target });
            yield {
              type: "finish" as const,
              finishReason: "tool-calls" as const,
            };
            return;
          }
          if (!history.includes('"name":"apply_reviewed_replacement"')) {
            const before = await readFile(workspace + "/review.txt", "utf8");
            yield call("apply_reviewed_replacement", {
              path: target,
              expectedDigest:
                "sha256:" + createHash("sha256").update(before).digest("hex"),
              oldText: "before",
              newText: "after <img src=x onerror=alert(1)>",
            });
            yield {
              type: "finish" as const,
              finishReason: "tool-calls" as const,
            };
            return;
          }
        }
        if (
          prompt.includes("check-probe") &&
          !history.includes('"name":"run_check"')
        ) {
          yield call("run_check", {
            check: "test",
            expectedScript: "node -e 'process.exit(7)'",
          });
          yield {
            type: "finish" as const,
            finishReason: "tool-calls" as const,
          };
          return;
        }
        yield {
          type: "text-delta" as const,
          textDelta: "I inspected the workspace. ",
        };
        if (prompt.includes("wait-for-cancel"))
          await new Promise<void>((resolve) => {
            if (input.abortSignal?.aborted) resolve();
            else
              input.abortSignal?.addEventListener("abort", () => resolve(), {
                once: true,
              });
          });
        if (input.abortSignal?.aborted)
          throw Object.assign(new Error("Fixture aborted"), {
            name: "AbortError",
          });
        for (let i = 0; i < 5; i++) {
          await new Promise((r) => setTimeout(r, 40));
          yield {
            type: "text-delta" as const,
            textDelta: `Progress ${i + 1}. `,
          };
        }
        yield {
          type: "text-delta" as const,
          textDelta:
            "The operation is finished. Literal <img onerror=alert(1)> content. ",
        };
        yield { type: "finish" as const, finishReason: "stop" as const,
          usage: { inputTokens: 10, outputTokens: 20, totalTokens: 30 } };
      })();
    },
  };
  const assetsDirectory = new URL("../dist/", import.meta.url).pathname;
  async function boot() {
    const harness = await createHarness({
      workspace,
      modelInstance: model,
      provider: "openai",
      subagentProfiles: [],
      allowedChecks: ["test"],
      timeoutMs: 15_000,
      ...(interactive ? { unlimitedTokens: true, unlimitedSteps: true, unlimitedToolCalls: true, unlimitedDuration: true } : {}),
    });
    const initial = await attachRuntime(harness, root + "/socket", false, [
      "sk-never-expose-fixturetoken",
    ]);
    const runtime = manageWebRuntime(initial, async () => [
      {provider:"openai",providerName:"OpenAI",model:harness.config.model,name:"Fixture current",configured:true,capabilities:["chat","tools"],validation:"verified"},
      {provider:"anthropic",providerName:"Anthropic",model:"fixture-next",name:"Fixture next",configured:true,capabilities:["chat","tools"],validation:"unverified"},
      {provider:"gemini",providerName:"Gemini",model:"fixture-missing",name:"Fixture missing",configured:false,capabilities:["chat","tools"],validation:"unverified"},
    ], async selection => {
      const next = await createHarness({workspace,modelInstance:model,
        provider: selection.provider as "openai" | "anthropic", model: selection.model,
        subagentProfiles:[],allowedChecks:["test"],timeoutMs:15000,
        ...(interactive ? { unlimitedTokens: true, unlimitedSteps: true, unlimitedToolCalls: true, unlimitedDuration: true } : {})});
      return {attach: () => attachRuntime(next,root + "/socket",false,["sk-never-expose-fixturetoken"]),
        dispose: () => next.close()};
    });
    const secondWorkspace = root + "/beacon";
    await mkdir(secondWorkspace, { recursive: true });
    const secondHarness = await createHarness({
      workspace: secondWorkspace,
      modelInstance: createMockLanguageModel(),
      provider: "openai",
      subagentProfiles: [],
    });
    const second = await attachRuntime(secondHarness, root + "/socket", false);
    const server = await startWebServer({
      runtimes: [runtime, second],
      assetsDirectory,
    });
    return { server, runtime, harness };
  }
  return {
    root,
    workspace,
    boot,
    async cleanup() {
      await rm(root, { recursive: true, force: true });
    },
  };
}
