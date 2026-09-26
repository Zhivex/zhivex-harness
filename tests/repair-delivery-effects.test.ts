import { expect, test } from "bun:test";
import { tool, type ToolExecutionContext } from "@zhivex-ai/core";
import { z } from "zod";
import { createRepairController, REPAIR_CONTROLLER_KEY } from "../src/runtime/repair-controller.js";

const prior = `sha256:${"a".repeat(64)}`;
const changed = `sha256:${"b".repeat(64)}`;
for (const name of ["apply_reviewed_edits", "run_environment_command"]) {
  test(`failed ${name} after delivery retains a new candidate for recovery across resume`, async () => {
    const controller = createRepairController({}, true);
    Object.assign(controller.state, { phase: "delivered", candidate: prior,
      verifier: { command: "bun", args: ["test"], purpose: "assert requested behavior" } });
    const tools = controller.wrapTools({ [name]: tool({ name, schema: z.any(),
      requiresApproval: true, approvalMode: "interrupt", approvalVersion: "fixture",
      execute: async (): Promise<string> => { throw new Error("failed after changing files"); } }) });
    const context = { metadata: {}, toolCall: { id: "effect", name, input: {} },
      executionEnvironment: { kind: "zhivex-oci", inspectPatch: async () => ({ patchId: changed, entries: [{}] }) }
    } as unknown as ToolExecutionContext;
    await expect((tools[name] as any).execute({}, context)).rejects.toThrow("failed after changing files");
    const restored = createRepairController(context.metadata!, true);
    expect(restored.state).toMatchObject({ candidate: changed, phase: "recover", revision: 1, verifier: null });
    expect(restored.completionPending()).toBe(true);
    expect(restored.pending()).toBe(true);
    expect(tools[name]).toMatchObject({ requiresApproval: true, approvalMode: "interrupt", approvalVersion: "fixture" });
    expect(context.metadata![REPAIR_CONTROLLER_KEY]).toEqual(restored.snapshot());
  });
}
