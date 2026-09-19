/** Adversarial acceptance checks from the 2026-09-19 security review.
 * No credentials, network, real user data, or production changes. Exit 1 means
 * at least one reviewed security expectation is unmet.
 */
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { AgentApprovalRequest } from "@zhivex-ai/agents";
import { Workspace } from "../src/workspace.js";
import { createEditProposal } from "../src/edit-contracts.js";
import { formatApproval } from "../src/terminal-ui.js";
import { LOCAL_TOOL_NAMES } from "../src/tool-registry.js";
import { SECURITY_REVIEW_AUTHORITY_BEARING_TOOLS } from "./security-review-evidence.js";
import { createMockLanguageModel } from "@zhivex-ai/agents/testing";
import { createHarness, runHarness } from "../src/harness.js";
import { resolveHarnessConfig } from "../src/config.js";
import { createHarnessOciExecutionEnvironment, type HarnessOciRuntimeAdapter } from "../src/execution-environment.js";

const emit = (id: string, passed: boolean, evidence: Record<string, unknown>) => {
  console.log(JSON.stringify({ id, passed, ...evidence }));
  if (!passed) process.exitCode = 1;
};

const root = await mkdtemp(path.join(tmpdir(), "harness-security-review-"));
try {
  await writeFile(path.join(root, "value.txt"), "baseline");
  const first = await Workspace.open(root);
  const second = await Workspace.open(root);
  const { digest } = await first.readFile("value.txt");
  const proposals = ["first", "second"].map(content => {
    const changes = [{ path: "value.txt", expectedDigest: digest, content }];
    return { proposalId: createEditProposal({ changes }).proposalId, changes };
  });
  let arrive = 0;
  let release!: () => void;
  const barrier = new Promise<void>(resolve => { release = resolve; });
  // Both valid writers pause at the real asynchronous activity checkpoint
  // after their last digest check, before publication. No implementation mocks.
  const checkpoint = async () => {
    arrive++;
    if (arrive === 2) release();
    if (arrive <= 2) await barrier;
  };
  const deadline = setTimeout(release, 5_000);
  const results = await Promise.allSettled([
    first.applyPatchWithModes(proposals[0]!, new Map(), checkpoint),
    second.applyPatchWithModes(proposals[1]!, new Map(), checkpoint)
  ]);
  clearTimeout(deadline);
  const accepted = results.filter(result => result.status === "fulfilled").length;
  emit("SEC-01", accepted === 1, { acceptedConflictingWrites: accepted,
    finalContent: await readFile(path.join(root, "value.txt"), "utf8") });

  let rejectedStale = false;
  try { await first.applyPatch(proposals[0]!); } catch { rejectedStale = true; }
  emit("CONTROL-sequential-stale-digest", rejectedStale, { rejectedStale });
} finally {
  await rm(root, { recursive: true, force: true });
}

const marker = "REPLACEMENT_MUST_BE_VISIBLE_BEFORE_APPROVAL";
const approval: AgentApprovalRequest = {
  kind: "local-tool", provider: "fixture", id: "fixture-approval",
  name: "apply_reviewed_replacement", rawData: null,
  arguments: JSON.stringify({ path: "value.txt", expectedDigest: `sha256:${"a".repeat(64)}`,
    oldText: "x".repeat(2000), newText: marker })
};
const summary = formatApproval(approval);
const full = formatApproval(approval, { detail: "full" });
emit("SEC-02", summary.includes(marker) && !summary.includes("characters omitted"), {
  replacementVisibleByDefault: summary.includes(marker),
  omissionNoticeVisible: summary.includes("characters omitted"),
  fullViewAvailable: full.includes(marker)
});
const inventory = new Set<string>(SECURITY_REVIEW_AUTHORITY_BEARING_TOOLS.map(tool => tool.id));
const missing = [...LOCAL_TOOL_NAMES].filter(name => !inventory.has(name)).sort();
emit("SEC-03", missing.length === 0, { missingTools: missing });

const scopedRoot = await mkdtemp(path.join(tmpdir(), "harness-security-scope-"));
try {
  const workspace = await Workspace.open(scopedRoot);
  const config = resolveHarnessConfig({ workspace: scopedRoot, executionBackend: "oci" });
  if (config.execution.backend !== "oci") throw new Error("Invalid probe configuration.");
  // Only image discovery is simulated. Actual snapshot, persistence, tool and
  // runHarness paths execute. No container command or provider request is used.
  const runtime: HarnessOciRuntimeAdapter = {
    async inspectImage(imageReference) {
      return { runtime: "docker", runtimeVersion: "fixture", imageReference,
        imageId: `sha256:${"a".repeat(64)}`, imageDigest: `sha256:${"a".repeat(64)}` };
    },
    async run() { throw new Error("This probe must not execute a subprocess."); },
    async removeRunContainers() { return 0; },
    async cleanupOrphans() { return 0; }
  };
  const environment = await createHarnessOciExecutionEnvironment({
    config: config.execution, workspace, stateDirectory: config.stateDirectory, runtime
  });
  const alice = await environment.acquire({ runId: "same-run",
    scope: { tenantId: "tenant-a", userId: "alice", namespace: "a" } });
  const secretFixture = "TENANT_A_PRIVATE_FIXTURE";
  await writeFile(path.join(alice.workspace.root, "private-candidate.txt"), secretFixture);
  await alice.release?.({ status: "waiting_approval" });
  const harness = await createHarness({ workspace: scopedRoot,
    stateDirectory: config.stateDirectory, executionBackend: "oci", ociRuntimeAdapter: runtime,
    provider: "qwen", tenantId: "tenant-b", userId: "bob", namespace: "b", subagentProfiles: [],
    modelInstance: createMockLanguageModel({ streamEvents: [
      [{ type: "tool-call", toolCall: { id: "read", name: "read_file", input: { path: "private-candidate.txt" } } },
        { type: "finish", finishReason: "tool-calls" }],
      [{ type: "text-delta", textDelta: "done" }, { type: "finish", finishReason: "stop" }]
    ] }) });
  try {
    const result = await runHarness(harness, { runId: "same-run", scope: harness.config.scope,
      prompt: "Read private-candidate.txt", toolExecution: { stopOnError: false } });
    const leaked = JSON.stringify(result.toolResults).includes(secretFixture);
    emit("SEC-04", !leaked && result.toolResults.length === 1 && result.toolResults[0]?.isError === true, { throughPublicRunHarness: true, status: result.status,
      differentTenantUserNamespace: true, otherTenantCandidateInToolOutput: leaked });
  } finally { await harness.close(); }
} finally { await rm(scopedRoot, { recursive: true, force: true }); }
