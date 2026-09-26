import { expect, test } from "bun:test";
import type { AgentApprovalRequest, AgentStreamEvent } from "@zhivex-ai/agents";
import { resolveTerminalApprovals } from "../src/cli/terminal/terminal-ui.js";
import { consoleProgressGuard } from "../src/cli/console/console-progress.js";
import { consoleBudgetOptions } from "../src/cli/console/console-budget.js";
import { parseCliArgs } from "../src/cli/arguments.js";
import { terminalApprovalResolver } from "../src/cli/presentation.js";
const check = (script = "bun test", overrides = {}): AgentApprovalRequest => ({
  id: "check", kind: "local-tool", provider: "fixture", name: "run_check",
  arguments: JSON.stringify({ check: "test", expectedScript: script }), rawData: null, ...overrides,
});

test("interactive defaults align tools, errors and time without overriding explicit limits", () => {
  const defaults = consoleBudgetOptions(parseCliArgs(["chat"]), {});
  expect([defaults.maxSteps, defaults.maxToolCalls, defaults.maxToolErrors, defaults.timeoutMs]).toEqual([50, 200, 20, 3600000]);
  const explicit = consoleBudgetOptions({...defaults, maxToolCalls: 2, maxToolErrors: 0, timeoutMs: 1000}, {});
  expect([explicit.maxToolCalls, explicit.maxToolErrors, explicit.timeoutMs]).toEqual([2, 0, 1000]);
  const env = consoleBudgetOptions(parseCliArgs(["chat"]), {ZHIVEX_HARNESS_MAX_TOOL_CALLS:"10", ZHIVEX_HARNESS_MAX_TOOL_ERRORS:"1", ZHIVEX_HARNESS_TIMEOUT_MS:"1000"});
  expect(env.maxToolCalls).toBeUndefined(); expect(env.maxToolErrors).toBeUndefined(); expect(env.timeoutMs).toBeUndefined();
});

test("session approvals match exact script, workspace, provider and child; unknown tools cannot inherit", async () => {
  const sessionGrants = new Set<string>(); let prompts = 0;
  const options = { workspace: "/workspace", sessionGrants, write: () => {}, ask: async () => { prompts++; return "s"; } };
  await resolveTerminalApprovals([check()], options);
  await resolveTerminalApprovals([check("bun test", { id: "next" })], options);
  expect(prompts).toBe(1);
  for (const [approval, workspace] of [
    [check("bun test --update-snapshots"), "/workspace"], [check(), "/other"],
    [check("bun test", {provider:"other"}), "/workspace"], [check("bun test", {childAgentId:"child"}), "/workspace"],
    [check("bun test", {kind:"provider"}), "/workspace"],
    [check("bun test", {arguments:JSON.stringify({check:"test", expectedScript:"bun test", extra:true})}), "/workspace"],
  ] as const) {
    expect((await resolveTerminalApprovals([approval], {...options, workspace, ask: async () => "n"}))?.[0]?.approve).toBe(false);
  }
});

test("abandoning a batch rolls back all new session grants including mixed dependency batches", async () => {
  const sessionGrants = new Set<string>(); const answers = ["s", "q"];
  const options = { workspace:"/workspace", sessionGrants, write:()=>{}, ask:async()=>answers.shift()! };
  expect(await resolveTerminalApprovals([check(), check("bun run lint")], options)).toBeUndefined();
  expect(sessionGrants.size).toBe(0);
  const mixed = terminalApprovalResolver("ask", async()=>"", {workspace:"/workspace", sessionGrants, select:async <T>()=>answers.shift() as T | undefined});
  answers.push("s", "q");
  expect(await mixed([check(), {...check(), name:"read_dependency", arguments:'{"package":"sdk"}'}], {} as never)).toBeUndefined();
  expect(sessionGrants.size).toBe(0);
});

test("loop guard stops three repeated failures, but permits corrections and successful progress", () => {
  const guard = consoleProgressGuard();
  const emit = (id:string, input:string, isError=true) => {
    guard.observe({type:"tool-call",toolCall:{id,name:"read_file",input:{path:input}}} as AgentStreamEvent);
    guard.observe({type:"tool-result",toolResult:{toolCallId:id,toolName:"read_file",isError,output:"missing"}} as AgentStreamEvent);
  };
  emit("1", "a"); emit("2", "a"); expect(guard.signal.aborted).toBe(false);
  emit("3", "b"); emit("4", "b",false); emit("5", "b"); emit("6", "b");
  expect(guard.signal.aborted).toBe(false);
  emit("7", "b"); expect(guard.signal.aborted).toBe(true);
});

test("legacy dependency approvals use ordinary approval policy without package grants", async () => {
  const request = {...check(), name:"read_dependency", arguments:'{"package":"sdk"}'};
  expect((await terminalApprovalResolver("auto")([request],{} as never))?.[0]?.approve).toBe(true);
  expect((await terminalApprovalResolver("restricted")([request],{} as never))?.[0]?.approve).toBe(false);
  expect((await terminalApprovalResolver("ask",async()=>"n")([request],{} as never))?.[0]?.approve).toBe(false);
});
