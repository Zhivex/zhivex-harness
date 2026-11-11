import { test, expect } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { createMockLanguageModel } from "@zhivex-ai/agents/testing";
import { createHarness, createProfiledHarness, runHarness, HARNESS_INSTRUCTIONS } from "../src/runtime/harness.js";
import { GENERAL_ASSISTANT_PROFILE } from "../src/runtime/agent-profile.js";

test("default coding behavior stays intact; general profile has no coding tools or instructions", async () => {
  const workspace = await mkdtemp("/tmp/profile-");
  const hosts: Awaited<ReturnType<typeof createHarness>>[] = [];
  try {
    const coding = await createHarness({ workspace, modelInstance: createMockLanguageModel(), subagentProfiles: [] }); hosts.push(coding);
    expect(coding.agent.instructions).toContain(HARNESS_INSTRUCTIONS.split("\n")[0]!);
    const general = await createProfiledHarness({ workspace, modelInstance: createMockLanguageModel(), agentProfile: GENERAL_ASSISTANT_PROFILE }); hosts.push(general);
    expect(general.agent.instructions).toBe(GENERAL_ASSISTANT_PROFILE.instructions);
    expect(Object.keys(general.agent.tools ?? {})).toHaveLength(0);
    expect(general.config.orchestration.profiles).toEqual([]);
    await expect(createProfiledHarness({ workspace, agentProfile: GENERAL_ASSISTANT_PROFILE, toolNames: ["read_file"] })).rejects.toThrow("cannot expand");
  } finally { for (const host of hosts) await host.close(); await rm(workspace, { recursive: true, force: true }); }
});

test("profile identity, version, instructions and catalog bind durable approvals", async () => {
  const workspace = await mkdtemp("/tmp/profile-resume-");
  const profile = { ...GENERAL_ASSISTANT_PROFILE, toolNames: ["apply_reviewed_replacement"] };
  let host: Awaited<ReturnType<typeof createHarness>> | undefined;
  try {
    await writeFile(workspace + "/note.txt", "before");
    host = await createProfiledHarness({ workspace, agentProfile: profile, modelInstance: createMockLanguageModel({ streamEvents: [[
      { type: "tool-call", toolCall: { id: "edit", name: "apply_reviewed_replacement", input: {
        path: "note.txt", expectedDigest: "sha256:" + createHash("sha256").update("before").digest("hex"), oldText: "before", newText: "after" } } },
      { type: "finish", finishReason: "tool-calls" }
    ]] }) });
    const pending = await runHarness(host, { prompt: "Update the note" });
    expect(pending.status).toBe("waiting_approval");
    const fingerprint = host.agent.harness?.fingerprint;
    await host.close(); host = undefined;
    for (const change of [{ id: "other" }, { version: "2" }, { instructions: "Another assistant" }, { toolNames: ["apply_reviewed_replacement", "read_file"] }]) {
      host = await createProfiledHarness({ workspace, agentProfile: { ...profile, ...change }, modelInstance: createMockLanguageModel() });
      expect(host.agent.harness?.fingerprint).not.toBe(fingerprint);
      await expect(runHarness(host, { state: pending.state })).rejects.toThrow(/fingerprint|binding|harness/i);
      await host.close(); host = undefined;
    }
    host = await createProfiledHarness({ workspace, agentProfile: profile, modelInstance: createMockLanguageModel() });
    expect(host.agent.harness?.fingerprint).toBe(fingerprint);
    profile.instructions = "Mutated caller object";
    expect(host.agent.instructions).toBe(GENERAL_ASSISTANT_PROFILE.instructions);
  } finally { await host?.close(); await rm(workspace, { recursive: true, force: true }); }
});
