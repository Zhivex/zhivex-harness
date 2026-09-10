import path from "node:path";
import { createHash } from "node:crypto";
import { readRegularFileNoFollow } from "../../src/file-security.js";
import type { HarnessExecutionSession } from "../../src/execution-environment.js";

/** Private evaluator data, never a tool result or part of the sanitized samples. */
export async function captureCandidate(session: HarnessExecutionSession) {
  const patch = await session.inspectPatch();
  const entries = [];
  let bytes = 0;
  for (const entry of patch.entries) {
    let content: string | undefined;
    if (entry.operation !== "delete") {
      const file = await readRegularFileNoFollow(path.join(session.workspace.root, entry.path), { label: "Candidate file", maxBytes: 1024 * 1024 });
      if (`sha256:${createHash("sha256").update(file.contents).digest("hex")}` !== entry.afterDigest) throw new Error("Candidate changed during capture.");
      bytes += file.contents.length;
      if (bytes > 2 * 1024 * 1024) throw new Error("Candidate exceeds the private capture limit.");
      content = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(file.contents);
    }
    entries.push({ ...entry, ...(content !== undefined ? { content } : {}) });
  }
  return { patchId: patch.patchId, entries };
}
