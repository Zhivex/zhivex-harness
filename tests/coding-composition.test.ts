import { test, expect } from "bun:test";
import { mkdtemp, rm, writeFile, symlink } from "node:fs/promises";
import { createMockLanguageModel } from "@zhivex-ai/agents/testing";
import { createCodingHarness } from "../src/runtime/coding-composition.js";
import { runHarness } from "../src/runtime/harness.js";
import { resolveHarnessConfig } from "../src/runtime/config.js";
import { openHarnessProjectMemory } from "../src/persistence/project-memory.js";

test("shared Code composition enables curated project memory by default and honors explicit opt-out", async () => {
  const workspace = await mkdtemp("/tmp/coding-composition-");
  try {
    const options = { workspace, provider: "openai", namespace: "test", subagentProfiles: [] };
    const memory = await openHarnessProjectMemory(resolveHarnessConfig(options));
    memory.remember({ content: "sqlite project uses numbered migrations", source: "Operator decision" }); memory.close();
    for (const enabled of [true, false]) {
      const model = createMockLanguageModel({ streamEvents: [[{ type: "text-delta", textDelta: "Understood." }, { type: "finish", finishReason: "stop" }]] }); const stream = model.stream!; let messages = "";
      model.stream = input => { messages = JSON.stringify(input.messages); return stream(input); };
      const harness = await createCodingHarness({ ...options, modelInstance: model, ...(enabled ? {} : { projectMemory: false }) });
      try {
        await runHarness(harness, { prompt: "sqlite project migrations" });
        expect(messages.includes("sqlite project uses numbered migrations")).toBe(enabled);
      } finally { await harness.close(); }
    }
  } finally { await rm(workspace, { recursive: true, force: true }); }
});

test("shared pricing-file composition rejects malformed input and symbolic links before provider use", async () => {
  const workspace = await mkdtemp("/tmp/coding-pricing-");
  try {
    const filename = workspace + "/pricing.json";
    await writeFile(filename, '{"schemaVersion":1,"prices":[]}');
    await symlink(filename, workspace + "/alias.json");
    const options = { workspace, modelInstance: createMockLanguageModel(), subagentProfiles: [] };
    await expect(createCodingHarness({ ...options, pricingFile: workspace + "/alias.json" })).rejects.toThrow();
    await writeFile(filename, "invalid JSON");
    await expect(createCodingHarness({ ...options, pricingFile: filename })).rejects.toThrow();
  } finally { await rm(workspace, { recursive: true, force: true }); }
});
