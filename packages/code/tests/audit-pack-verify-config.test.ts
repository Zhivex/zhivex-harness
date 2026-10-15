import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { expect, test } from "bun:test";
import { exportHarnessAuditPack } from "@zhivex-ai/harness/audit";
import { auditPackCli } from "../src/cli/audit-pack.js";
import { parseCliArgs } from "../src/cli/arguments.js";

const state = { runId: "run-1", revision: 1, status: "completed", messages: [], pendingApprovals: [], childRuns: [], metadata: {}, outputText: "" };

test("code verify-audit skips runtime configuration and export still resolves it", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "code-audit-verify-"));
  const directory = path.join(root, "pack");
  const previousStore = process.env.ZHIVEX_HARNESS_STORE;
  const previousKey = process.env.ZHIVEX_AUDIT_SIGNING_KEY;
  const signing = "k".repeat(32);
  process.env.ZHIVEX_AUDIT_SIGNING_KEY = signing;
  try {
    await exportHarnessAuditPack({
      store: { load: async (id: string) => id === "run-1" ? structuredClone(state) : undefined, save: async () => { throw new Error("EXPORT_MUST_NOT_WRITE"); } } as never,
      subjectId: "run-1", directory, signingKey: Buffer.from(signing), now: 1_700_000_000_000
    });
    process.env.ZHIVEX_HARNESS_STORE = "not-a-store";
    await expect(auditPackCli(parseCliArgs(["verify-audit", "--out", directory, "--json"]))).resolves.toMatchObject({ fileCount: 5 });
    await expect(auditPackCli(parseCliArgs(["export-audit", "run-1", "--out", path.join(root, "next")]))).rejects.toThrow("storeBackend must be one of");
  } finally {
    if (previousStore === undefined) delete process.env.ZHIVEX_HARNESS_STORE;
    else process.env.ZHIVEX_HARNESS_STORE = previousStore;
    if (previousKey === undefined) delete process.env.ZHIVEX_AUDIT_SIGNING_KEY;
    else process.env.ZHIVEX_AUDIT_SIGNING_KEY = previousKey;
    await rm(root, { recursive: true, force: true });
  }
});
