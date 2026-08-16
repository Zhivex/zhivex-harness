import { describe, expect, test } from "bun:test";

import {
  EDIT_CONTRACT_SCHEMA_VERSION,
  createEditProposal,
  editProposalInputSchema,
  moveFileInputSchema,
  mutationAuditEntrySchema,
  validateEditProposal,
  workspaceFilePathSchema
} from "../src/edit-contracts.js";

const digest = `sha256:${"a".repeat(64)}`;

describe("trusted edit contracts", () => {
  test("creates deterministic proposals bound to path, digest, and content", () => {
    const first = createEditProposal({
      changes: [
        { path: "src/b.ts", expectedDigest: null, content: "export const b = 2;\n" },
        { path: "src/a.ts", expectedDigest: digest, content: "export const a = 1;\n" }
      ]
    });
    const reordered = createEditProposal({
      changes: [
        { path: "src/a.ts", expectedDigest: digest, content: "export const a = 1;\n" },
        { path: "src/b.ts", expectedDigest: null, content: "export const b = 2;\n" }
      ]
    });

    expect(first.schemaVersion).toBe(EDIT_CONTRACT_SCHEMA_VERSION);
    expect(first.kind).toBe("edit-proposal");
    expect(first.digestAlgorithm).toBe("sha256");
    expect(first.proposalId).toMatch(/^sha256:[a-f0-9]{64}$/);
    expect(first.proposalId).toBe(reordered.proposalId);
    expect(first.changes.map((change) => change.path)).toEqual(["src/a.ts", "src/b.ts"]);
    expect(first.changes.every((change) => !Object.hasOwn(change, "content"))).toBe(true);
  });

  test("detects any change after the proposal was reviewed", () => {
    const changes = [{ path: "src/a.ts", expectedDigest: digest, content: "before\n" }];
    const proposal = createEditProposal({ changes });

    expect(validateEditProposal({ proposalId: proposal.proposalId, changes })).toEqual({
      proposalId: proposal.proposalId,
      changes
    });
    expect(() => validateEditProposal({
      proposalId: proposal.proposalId,
      changes: [{ ...changes[0], content: "after\n" }]
    })).toThrow("proposalId does not match");
  });

  test("rejects duplicate targets, unsafe paths, malformed digests, and no-op moves", () => {
    expect(() => editProposalInputSchema.parse({
      changes: [
        { path: "src/a.ts", expectedDigest: null, content: "a" },
        { path: "src/a.ts", expectedDigest: null, content: "b" }
      ]
    })).toThrow("Duplicate target path");
    expect(() => workspaceFilePathSchema.parse("../outside.ts")).toThrow("normalized");
    expect(() => editProposalInputSchema.parse({
      changes: [{ path: "src/a.ts", expectedDigest: "abc", content: "a" }]
    })).toThrow("Digest must use");
    expect(() => moveFileInputSchema.parse({
      source: "src/a.ts",
      destination: "src/a.ts",
      expectedDigest: digest
    })).toThrow("must differ");
  });

  test("validates mutation audit records as a public contract", () => {
    expect(mutationAuditEntrySchema.parse({
      id: "mutation-1",
      operation: "move",
      path: "src/a.ts",
      destination: "src/b.ts",
      beforeDigest: digest,
      afterDigest: digest,
      timestamp: "2026-08-16T12:00:00.000Z"
    })).toMatchObject({ operation: "move", destination: "src/b.ts" });
  });
});
