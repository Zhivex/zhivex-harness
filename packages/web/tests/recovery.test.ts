import { expect, test } from "bun:test";
import type { AgentStreamEvent } from "@zhivex-ai/agents";
import { mkdtemp, realpath, rm } from "node:fs/promises";
import { groupToolRows } from "../src/activity-groups.js";
import { modelRows, nextTypeaheadIndex, readModelPickerMemory, rememberWorkspaceModel } from "../src/model-picker-state.js";
import type { WebModelChoice } from "../src/contracts.js";
import { composerHostActions, planComposerSend } from "../src/composer-plan.js";
import { WEB_DEFAULT_STOP } from "../src/default-budgets.js";
import { WebLimitMonitor } from "../src/limit-monitor.js";
import { WebLimitStore } from "../src/limit-store.js";
import { mutationUnconfirmed } from "../src/mutation-outcome.js";
import { statusCopy } from "../src/status-copy.js";

test("a confirmed execution failure does not lock the session; a lost response does", () => {
  expect(mutationUnconfirmed("EXECUTION_FAILED")).toBe(false);
  expect(mutationUnconfirmed("INVALID_STATE")).toBe(false);
  expect(mutationUnconfirmed("The provider stream failed: QWEN_SSE_EVENT_INVALID (Responses, invalid JSON).")).toBe(false);
  expect(mutationUnconfirmed("WEB_REQUEST_FAILED")).toBe(true);
  expect(mutationUnconfirmed("WEB_MODEL_CHANGE_BUSY")).toBe(true);
  const copy = statusCopy("EXECUTION_FAILED");
  expect(copy.title).toBe("The task stopped");
  expect(copy.next.toLowerCase()).toContain("send it again");
  expect(`${copy.title} ${copy.next}`).not.toContain("EXECUTION FAILED");
  expect(statusCopy("WEB_REQUEST_FAILED").next.toLowerCase()).toContain("reconcile");
});

test("the first message creates a session and then starts the task", () => {
  expect(planComposerSend({ text: "Inspect the repo", hasSession: false, noCredentials: false, canSend: true })).toBe("create-and-start");
  expect(composerHostActions("create-and-start")).toEqual(["create", "start"]);
  expect(planComposerSend({ text: "  ", hasSession: false, noCredentials: false, canSend: true })).toBe("ignore");
  expect(planComposerSend({ text: "Inspect", hasSession: false, noCredentials: true, canSend: true })).toBe("need-credentials");
});

test("configured providers stay first, search still finds the others, and the last-used model leads its group", () => {
  const choice = (provider: string, model: string, configured: boolean): WebModelChoice => ({
    provider, providerName: provider, model, name: model, configured, capabilities: ["chat"], validation: "verified",
  });
  const choices = [choice("openai", "ready-model", true), choice("qwen", "hidden-model", false)];
  const memory = rememberWorkspaceModel(readModelPickerMemory(null), "workspace", "openai/ready-model");
  expect(memory.configuredOnly).toBe(true);
  const hidden = modelRows(choices, memory, "", { configuredOnly: true, preferredKey: "openai/ready-model" });
  expect(hidden.every(row => row.choice.model === "ready-model")).toBe(true);
  expect(hidden.length).toBeGreaterThan(0);
  expect(modelRows(choices, memory, "hidden", { configuredOnly: true }).map(row => row.choice.model)).toEqual(["hidden-model"]);
  expect(nextTypeaheadIndex(["ready-model", "hidden-model"], "h", 0)).toBe(1);
});

test("consecutive read-only calls collapse into one explored group", () => {
  const groups = groupToolRows([
    { name: "list_dir", status: "completed" },
    { name: "read_file", status: "completed" },
    { name: "grep", status: "completed" },
    { name: "run_check", status: "failed", exitCode: 7 },
    { name: "read_file", status: "completed" },
  ]);
  expect(groups.map(group => group.kind === "explore" ? `explored ${group.count}` : group.tool.name)).toEqual([
    "explored 3",
    "run_check",
    "explored 1",
  ]);
});

test("tool-only streams count a step, and default budgets stop read-only exploration", async () => {
  const directory = await realpath(await mkdtemp("/tmp/web-step-count-"));
  try {
    const store = new WebLimitStore(directory, "atlas");
    let cancelled = 0;
    const monitor = new WebLimitMonitor(store, async () => { cancelled++; }, null, () => 0, undefined, WEB_DEFAULT_STOP);
    try {
      await monitor.admitted("session", "run_test");
      await monitor.event("session", "run_test", { type: "agent-run-start", currentStep: 0, maxSteps: "unlimited" });
      await monitor.event("session", "run_test", { type: "agent-step-finish", step: {
        index: 0, status: "completed", request: { messages: [] }, response: { messages: [] }, toolResults: [],
      } });
      expect(monitor.snapshot("run_test")?.consumption.steps).toBe(1);
      for (let index = 0; index < 135; index++) {
        const event: AgentStreamEvent = { type: "tool-result", toolResult: { toolCallId: `read-${index}`, toolName: "read_file", isError: false } };
        await monitor.event("session", "run_test", event);
      }
      const record = await store.readRun("run_test");
      expect(record?.consumption.steps).toBeGreaterThan(0);
      expect(record?.consumption.toolCalls).toBe(135);
      expect(record?.settings.toolCalls).toEqual({ value: 32, action: "stop" });
      expect(cancelled).toBe(1);
    } finally { await monitor.close(); }
  } finally { await rm(directory, { recursive: true, force: true }); }
});
