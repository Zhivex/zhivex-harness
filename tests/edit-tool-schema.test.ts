import { expect, test } from "bun:test";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { toolInputJsonSchema } from "@zhivex-ai/core";
import {
  applyEditProposalInputSchema,
  createEditProposal,
  editChangeSchema,
  editProposalInputSchema
} from "../src/workspace/edit-contracts.js";
import { replacementEditSchema } from "../src/workspace/replacement-edits.js";
import { verifiedReviewedEditsInputSchema } from "../src/tools/shared.js";
import { Workspace } from "../src/workspace/workspace.js";

const changeFields = ["content", "expectedDigest", "path"];

const walk = (value: unknown, visit: (record: Record<string, unknown>) => void) => {
  if (Array.isArray(value)) {
    for (const item of value) walk(item, visit);
    return;
  }
  if (!value || typeof value !== "object") return;
  const record = value as Record<string, unknown>;
  visit(record);
  for (const child of Object.values(record)) walk(child, visit);
};

test("provider edit schemas keep the main field set and omit allowControlBytes", () => {
  const propose = toolInputJsonSchema(editProposalInputSchema);
  const apply = toolInputJsonSchema(applyEditProposalInputSchema);
  const replacement = toolInputJsonSchema(replacementEditSchema);
  const verified = toolInputJsonSchema(verifiedReviewedEditsInputSchema);
  const derived = toolInputJsonSchema(replacementEditSchema.omit({ expectedDigest: true }));
  for (const schema of [propose, apply, replacement, verified, derived]) {
    expect(JSON.stringify(schema)).not.toContain("allowControlBytes");
    walk(schema, (record) => {
      expect(record).not.toHaveProperty("const");
    });
  }
  const proposeChanges = (propose.properties as { changes: { items: { properties: object } } }).changes.items.properties;
  const applyProperties = apply.properties as { changes: { items: { properties: object } } };
  expect(Object.keys(propose.properties as object).sort()).toEqual(["changes"]);
  expect(Object.keys(proposeChanges).sort()).toEqual(changeFields);
  expect(Object.keys(apply.properties as object).sort()).toEqual(["changes", "proposalId"]);
  expect(Object.keys(applyProperties.changes.items.properties).sort()).toEqual(changeFields);
  expect(Object.keys(replacement.properties as object).sort()).toEqual(["expectedDigest", "newText", "oldText", "path"]);
  expect(editChangeSchema.safeParse({
    path: "src/index.ts",
    expectedDigest: null,
    content: "ok\n",
    allowControlBytes: true
  }).success).toBe(false);
});

test("model-supplied control bytes are still refused", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "zhivex-edit-schema-"));
  try {
    await mkdir(path.join(root, "src"));
    await writeFile(path.join(root, "src", "index.ts"), "export const value = 1;\n");
    const workspace = await Workspace.open(root);
    const current = await workspace.readFile("src/index.ts");
    const changes = [{ path: "src/index.ts", expectedDigest: current.digest, content: "export const value = 1;\n\0" }];
    await expect(workspace.applyPatch({
      proposalId: createEditProposal({ changes }).proposalId,
      changes
    })).rejects.toThrow("Refusing to write a control byte into a text file: NUL byte at L2");
    expect(await readFile(path.join(root, "src", "index.ts"), "utf8")).toBe("export const value = 1;\n");
    expect(workspace.mutationAudit()).toHaveLength(0);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
