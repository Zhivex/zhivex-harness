import type { AgentRunStore } from "@zhivex-ai/agents/ops";
import type { LanguageModelMiddleware, ModelGenerateInput, ToolSet } from "@zhivex-ai/core";
import type { Workspace } from "../workspace/workspace.js";
import { createProgressMonitor, PROGRESS_MONITOR_KEY } from "./progress-monitor.js";
import { createEmptyHarnessScopedContextState, discoverHarnessScopedContext, refreshHarnessScopedContext,
  harnessScopedContextStateSchema } from "../context/scoped-context.js";
import { harnessExecutionSession } from "../execution/execution-environment.js";

export const SCOPED_CONTEXT_KEY = "zhivexScopedContext";
/** Per invocation; only SDK-owned saves persist these observers. */
export async function createContextRuntime(workspace: Workspace, metadata: Record<string, unknown>, enabled: boolean) {
  const monitor = createProgressMonitor(metadata);
  let state = metadata[SCOPED_CONTEXT_KEY] === undefined ? createEmptyHarnessScopedContextState()
    : harnessScopedContextStateSchema.parse(metadata[SCOPED_CONTEXT_KEY]);
  let instructions = "";
  let scopedWorkspace = workspace;
  let discovery = Promise.resolve();
  const wrapTools = (tools: ToolSet): ToolSet => monitor.wrapTools(Object.fromEntries(Object.entries(tools).map(([name, definition]) => {
    if (!enabled || !["read_file", "read_files"].includes(name) || !("execute" in definition)) return [name, definition];
    return [name, { ...definition, async execute(input, context) {
      const result = await definition.execute(input, context);
      // A successful bounded read is the authorization boundary for these paths.
      const data = result as { path?: string; files?: { path?: string }[] };
      const paths = (data.files ?? [data]).flatMap(file => typeof file.path === "string" ? [file.path] : []);
      const currentWorkspace = harnessExecutionSession(context)?.workspace ?? workspace;
      const next = discovery.then(async () => {
        const refreshed = await refreshHarnessScopedContext(currentWorkspace, state);
        const discovered = await discoverHarnessScopedContext(currentWorkspace, { paths, state: refreshed.state });
        state = discovered.state;
        scopedWorkspace = currentWorkspace;
        instructions = discovered.instructions;
        if (context?.metadata) context.metadata[SCOPED_CONTEXT_KEY] = state;
      });
      discovery = next;
      await next;
      return result;
    } } satisfies typeof definition];
  })));
  const prepare = async (input: ModelGenerateInput) => {
    await discovery;
    if (enabled) {
      // Guidance is working context, not authorization. Normal edits or new
      // scoped instructions refresh the next request instead of killing a run.
      // Unsafe files still fail the descriptor-bound reader before model use.
      const refreshed = await refreshHarnessScopedContext(scopedWorkspace, state);
      state = refreshed.state;
      instructions = refreshed.instructions;
    }
    const signal = monitor.check();
    if (signal.action === "stop") throw new Error("NO_PROGRESS: repeated actions produced unchanged evidence; revise the task before continuing.");
    const text = [instructions, signal.action === "recover"
      ? "Progress monitor: repeated actions returned unchanged evidence. Change the hypothesis, seek new evidence, or report the specific blocker. Do not repeat the same cycle." : ""].filter(Boolean).join("\n\n");
    if (text) input.messages = [{ role: "system", parts: [{ type: "text", text }] }, ...input.messages];
  };
  const middleware: LanguageModelMiddleware = {
    name: "harness-context-progress-v2",
    async wrapGenerate(context, next) {
      await prepare(context.input);
      const result = await next();
      // Narrating an unchanged tool cycle is not new evidence. Observe prose
      // only on text-only turns; tool results drive progress for tool turns.
      const messages = [...(result.messages ?? []), ...(result.message ? [result.message] : [])];
      if (!messages.some(message => message.parts.some(part => part.type === "tool-call"))) monitor.observeText(result.text ?? "");
      return result;
    },
    async wrapStream(context, next) {
      await prepare(context.input);
      const stream = await next();
      return (async function* () {
        let text = "";
        let toolCalled = false;
        for await (const event of stream) {
          if (event.type === "text-delta") text = (text + event.textDelta).slice(-8000);
          if (event.type === "tool-call") toolCalled = true;
          if (event.type === "finish" && !toolCalled) monitor.observeText(text);
          yield event;
        }
      })();
    }
  };
  const store = (original: AgentRunStore, runId: string): AgentRunStore => new Proxy(original, {
    get(target, key) {
      if (key === "save") return async (...args: Parameters<AgentRunStore["save"]>) => {
        if (args[0].runId === runId) args[0].metadata = { ...args[0].metadata,
          [PROGRESS_MONITOR_KEY]: monitor.snapshot(), ...(enabled ? { [SCOPED_CONTEXT_KEY]: state } : {}) };
        return target.save(...args);
      };
      const value: unknown = Reflect.get(target, key, target);
      return typeof value === "function" ? value.bind(target) : value;
    }
  });
  return { wrapTools, middleware, store };
}
