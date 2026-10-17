import { expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  appendAutoApproval,
  buildSnapshots,
  classifyApproval,
  createAutoApprovalEntry,
  decideBatch,
  parseAllowlist,
  parseApprovalConfig,
  planUndo,
  resolveAutoApprovePolicy,
  revertAutoApproval,
  type AutoApprovePolicy,
} from "../src/approvals/auto-approve.js";

const root = "/workspace/demo";
const policy = (mode: AutoApprovePolicy["mode"], allow: string[] = [], overLimit = false): AutoApprovePolicy => ({
  mode, commandAllowlist: allow, rootDir: root, ...(overLimit ? { overLimit: true } : {}),
});
const edit = (file = "src/index.ts", content = "next\n") => ({
  name: "apply_reviewed_edits",
  arguments: JSON.stringify({ changes: [{ path: file, expectedDigest: "sha256:" + "a".repeat(64), content }] }),
});

test("manual is the default and never auto-approves an ordinary edit", () => {
  const resolved = resolveAutoApprovePolicy({ rootDir: root });
  expect(resolved.mode).toBe("manual");
  expect(classifyApproval({ name: "apply_reviewed_edits", paths: [{ path: "src/index.ts", operation: "update" }], commands: [] }, resolved).decision).toBe("ask");
});

test("auto-edits approves an in-root edit and still asks for commands", () => {
  const edits = policy("auto-edits");
  expect(classifyApproval({ name: "apply_reviewed_edits", paths: [{ path: "src/index.ts", operation: "update" }], commands: [] }, edits)).toEqual({ decision: "auto", reason: "edit-in-root" });
  expect(classifyApproval({ name: "run_check", paths: [], commands: ["bun test"] }, edits)).toMatchObject({ decision: "ask", reason: "not-an-edit" });
});

test("auto-limits approves an allowlisted command and refuses wildcards", () => {
  const limited = policy("auto-limits", parseAllowlist(["bun", "git"]));
  expect(classifyApproval({ name: "run_check", paths: [], commands: ["bun test"] }, limited)).toEqual({ decision: "auto", reason: "allowlisted-command" });
  expect(() => parseAllowlist(["bun *"])).toThrow("AUTO_APPROVE_ALLOWLIST_INVALID");
  expect(classifyApproval({ name: "run_check", paths: [], commands: ["npm test"] }, policy("auto-limits", ["*"]))).toMatchObject({ decision: "ask" });
});

test("the always-ask list cannot be bypassed by mode or allowlist", () => {
  const open = policy("auto-limits", ["git", "npm", "pnpm", "bun", "yarn", "cargo", "curl", "rm", "ssh"]);
  const cases: { facts: Parameters<typeof classifyApproval>[0]; reason: string }[] = [
    { facts: { name: "run_environment_shell", paths: [], commands: ["curl https://example.com"] }, reason: "network" },
    { facts: { name: "run_environment_command", paths: [], commands: ["ssh host"] }, reason: "network" },
    { facts: { name: "web_fetch", paths: [], commands: [] }, reason: "network" },
    { facts: { name: "run_environment_shell", paths: [], commands: ["git push origin main"] }, reason: "git-push" },
    { facts: { name: "run_environment_shell", paths: [], commands: ["git -C src push"] }, reason: "git-push" },
    { facts: { name: "run_check", paths: [], commands: ["npm publish"] }, reason: "package-publish" },
    { facts: { name: "run_check", paths: [], commands: ["bun publish"] }, reason: "package-publish" },
    { facts: { name: "run_check", paths: [], commands: ["cargo publish"] }, reason: "package-publish" },
    { facts: { name: "apply_reviewed_edits", paths: [{ path: "../outside.txt", operation: "update" }], commands: [] }, reason: "write-outside" },
    { facts: { name: "apply_reviewed_edits", paths: [{ path: "/etc/passwd", operation: "update" }], commands: [] }, reason: "write-outside" },
    { facts: { name: "quarantine_file", paths: [{ path: "../secret.txt", operation: "delete" }], commands: [] }, reason: "delete-outside" },
    { facts: { name: "run_environment_shell", paths: [], commands: ["rm ../../etc/passwd"] }, reason: "delete-outside" },
    { facts: { name: "apply_reviewed_edits", paths: [{ path: ".env", operation: "update" }], commands: [] }, reason: "secret" },
    { facts: { name: "apply_reviewed_replacement", paths: [{ path: "secrets/token.txt", operation: "update" }], commands: [] }, reason: "secret" },
    { facts: { name: "apply_reviewed_edits", paths: [{ path: "id_rsa", operation: "update" }], commands: [] }, reason: "secret" },
    { facts: { name: "apply_reviewed_edits", paths: [{ path: "src/index.ts", operation: "update" }], commands: [] }, reason: "over-limit" },
  ];
  for (const item of cases) {
    const result = classifyApproval(item.facts, item.reason === "over-limit" ? policy("auto-limits", open.commandAllowlist, true) : open);
    expect(result, item.reason).toEqual({ decision: "ask", reason: item.reason });
  }
  expect(decideBatch([edit(), { name: "run_check", arguments: JSON.stringify({ expectedScript: "git push" }) }], open).auto).toBe(false);
  expect(decideBatch([edit("src/app.ts"), edit(".env")], open).auto).toBe(false);
});

test("a session manual override beats a workspace auto-edits file", () => {
  const resolved = resolveAutoApprovePolicy({
    rootDir: root,
    file: { mode: "auto-edits", commandAllowlist: ["bun"] },
    cliMode: "auto-limits",
    sessionMode: "manual",
  });
  expect(resolved.mode).toBe("manual");
  expect(parseApprovalConfig('{"mode":"auto-edits","commandAllowlist":["bun"]}')).toEqual({ mode: "auto-edits", commandAllowlist: ["bun"] });
  expect(() => parseApprovalConfig('{"mode":"auto","commandAllowlist":["*"]}')).toThrow("AUTO_APPROVE_CONFIG_INVALID");
});

test("undo restores the previous file only while it still matches the approved text", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "auto-approve-"));
  try {
    const snapshots = buildSnapshots(edit("src/index.ts", "next\n").arguments, () => ({ text: "before\n", undoable: true }));
    expect(snapshots[0]).toMatchObject({ before: "before\n", after: "next\n", undoable: true });
    const entry = createAutoApprovalEntry({ approvalId: "approval-1", name: "apply_reviewed_edits", mode: "auto-edits", reason: "edit-in-root", snapshots });
    await appendAutoApproval(directory, entry);
    await mkdir(path.join(directory, "src"), { recursive: true });
    await Bun.write(path.join(directory, "src/index.ts"), "next\n");
    const reverted = await revertAutoApproval(directory, entry.id);
    expect(reverted.ok).toBe(true);
    expect(await readFile(path.join(directory, "src/index.ts"), "utf8")).toBe("before\n");
    const changed = planUndo(entry, new Map([["src/index.ts", "somebody else\n"]]));
    expect(changed.ok).toBe(false);
  } finally { await rm(directory, { recursive: true, force: true }); }
});
