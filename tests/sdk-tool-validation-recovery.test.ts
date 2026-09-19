import { serializeJsonValue } from "@zhivex-ai/core";
import { expect, test } from "bun:test";
import { mkdtemp, writeFile, readFile, rm } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { createMockLanguageModel } from "@zhivex-ai/agents/testing";
import { createInMemoryAgentRunStore } from "@zhivex-ai/agents/ops";
import { createHarness, runHarness } from "../src/harness.js";
import { sanitizeOperationalError } from "../scripts/swebench/telemetry.js";

const usage = { inputTokens: 10, outputTokens: 2, totalTokens: 12 };
const call = (id: string, name: string, input: unknown) => ({ type: "tool-call" as const, toolCall: { id, name, input: serializeJsonValue(input) } });
const finish = { type: "finish" as const, finishReason: "tool-calls" as const, usage };
const bad = (id: string) => call(id, "read_files", { files: [{ path: "a.txt", endLine: "private-invalid-value" }] });
const done = [{ type: "text-delta" as const, textDelta: "done" }, { type: "finish" as const, finishReason: "stop" as const, usage }];

for (const mode of ["strict", "corrected", "bounded", "approval"] as const) {
  test(`published SDK validation recovery through harness: ${mode}`, async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "zhx-sdk-validation-"));
    let harness: Awaited<ReturnType<typeof createHarness>> | undefined;
    try {
      await writeFile(path.join(root, "a.txt"), "fixture\n");
      const streams = mode === "approval" ? [[bad("bad"), call("write", "apply_reviewed_edits", { changes: [
        { path: "created.txt", expectedDigest: null, content: "approved\n" }
      ] }), finish], done] : [[bad("bad-1"), finish],
        mode === "bounded" ? [bad("bad-2"), finish] : [call("corrected", "read_files", { files: [{ path: "a.txt", endLine: 1 }] }), finish], done];
      const model = createMockLanguageModel({ streamEvents: streams });
      let reads = 0, requests = 0;
      const originalStream = model.stream!;
      model.stream = async (input) => { requests++; return originalStream(input); };
      harness = await createHarness({ workspace: root, provider: "openai", modelInstance: model,
        store: createInMemoryAgentRunStore(), maxSteps: 4, maxToolErrors: mode === "bounded" ? 1 : 4 });
      const readTool = (harness.agent.tools as any).read_files;
      const execute = readTool.execute;
      readTool.execute = async (...args: any[]) => { reads++; return execute(...args); };
      const options = { toolExecution: { stopOnError: false, ...(mode === "strict" ? {} : { validationErrorMode: "tool-result" as const }) } };
      if (mode === "strict") {
        await expect(runHarness(harness, { prompt: "Read.", ...options })).rejects.toThrow("Invalid input for tool");
        expect(reads).toBe(0); expect(requests).toBe(1);
      } else if (mode === "bounded") {
        const outcome = await runHarness(harness, { prompt: "Read.", ...options }).catch(() => undefined);
        expect(outcome?.status).not.toBe("completed");
        expect(requests).toBe(2); expect(reads).toBe(0);
      } else {
        let approvals = 0;
        const outcome = await runHarness(harness, { prompt: "Read or apply the approved fixture.", ...options }, {
          resolveApprovals: async (pending) => {
            expect(mode).toBe("approval");
            expect(pending).toHaveLength(1); expect(pending[0]!.toolCallId).toBe("write");
            return pending.map(a => { approvals++; return { provider: a.provider, approvalRequestId: a.id, approve: true }; });
          }
        });
        expect(outcome.status).toBe("completed");
        expect(reads).toBe(mode === "corrected" ? 1 : 0);
        expect(approvals).toBe(mode === "approval" ? 1 : 0);
        expect(outcome.usage?.inputTokens).toBe(mode === "approval" ? 20 : 30);
        const error = outcome.toolResults.find(r => r.isError)!.error;
        expect(error).toMatchObject({ code: "TOOL_INPUT_VALIDATION_ERROR", issues: [{ code: "invalid_type", path: ["files", 0, "endLine"] }] });
        expect(JSON.stringify(error)).not.toContain("private-invalid-value");
        expect(sanitizeOperationalError(error).chain[0]!.validationCode).toBe("TOOL_INPUT_VALIDATION_ERROR");
        expect(sanitizeOperationalError(error).chain[0]!.validationIssues).toEqual([{ code: "invalid_type", path: ["files", 0, "endLine"] }]);
        if (mode === "approval") expect(await readFile(path.join(root, "created.txt"), "utf8")).toBe("approved\n");
      }
    } finally { await harness?.close(); await rm(root, { recursive: true, force: true }); }
  });
}
