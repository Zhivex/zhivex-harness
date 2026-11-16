import { openWorkspaceCheckpointStore, type CliSession, type CliSessionStore, type Workspace } from "@zhivex-ai/harness/engine";
import type { ConsoleInput } from "./console-input.js";
import { formatFileDiff } from "../terminal/file-diff.js";
import { sanitizeTerminalText } from "../terminal/terminal-ui.js";

const coverage = "Checkpoint coverage: 1–20 selected existing UTF-8 files, at most 64 KiB each. No creation, deletion, binary or mode restore. No automatic rollback.\n";

export const handleConsoleCheckpoint = async (command: string, context: {
  workspace: Workspace; sessions: CliSessionStore; session: CliSession;
  input: Pick<ConsoleInput, "select" | "question">; hasActiveTurn: () => Promise<unknown>;
  restoreSession: (session: CliSession) => Promise<void>; write?: (text: string) => void;
}) => {
  if (command !== "/checkpoint" && !command.startsWith("/checkpoint ")) return false;
  const write = context.write ?? (text => { process.stdout.write(text); });
  write(coverage);
  if (await context.hasActiveTurn()) { write("Finish or deny pending work before using checkpoints.\n"); return true; }
  const store = await openWorkspaceCheckpointStore(context.workspace, context.sessions);
  let fork: CliSession | undefined;
  try {
    const match = /^(\S+)(?:\s+([\s\S]*))?$/.exec(command.slice("/checkpoint".length).trim());
    const argument = match?.[1], target = match?.[2] ?? "";
    const action = argument || await context.input.select("Checkpoints", [
      { value: "capture", label: "Capture selected files" },
      { value: "list", label: "List captures and restore operations" },
      { value: "review", label: "Review a checkpoint" },
      { value: "restore", label: "Review and restore selected files" },
      { value: "retry", label: "Review an existing restore operation", detail: "Retains its original digests; conflicts require manual recovery" },
    ]);
    if (!action) return true;
    if (action === "list") {
      write(sanitizeTerminalText(JSON.stringify({ checkpoints: store.listCheckpoints(context.session.sessionId),
        restores: store.listRestores(context.session.sessionId), storage: store.storageStatus() }, null, 2)) + "\n");
    } else if (action === "capture") {
      const turn = context.session.runs.at(-1);
      if (!turn) { write("Complete a task before capturing its conversation turn.\n"); return true; }
      const raw = target || await context.input.question('Workspace paths as a JSON array (e.g. ["greeting.mjs"]): ');
      const paths: unknown = JSON.parse(raw);
      if (!Array.isArray(paths) || !paths.every(value => typeof value === "string")) throw new Error("Paths must be a JSON array of strings.");
      const checkpoint = await store.capture({ sessionId: context.session.sessionId, turnId: turn.turnId, paths });
      write(`Captured checkpoint ${checkpoint.id} · ${checkpoint.files.length} files · turn ${turn.turnId}\n`);
    } else if (["review", "restore", "retry"].includes(action)) {
      const choices = action === "retry" ? store.listRestores(context.session.sessionId).filter(item => item.stage !== "completed")
        .map(item => ({ value: item.id, label: item.id, detail: item.stage }))
        : store.listCheckpoints(context.session.sessionId).map(item => ({ value: item.id, label: item.id, detail: item.files.map(file => file.path).join(", ") }));
      const id = target || await context.input.select(action === "retry" ? "Restore operations" : "Saved checkpoints", choices);
      if (!id) return true;
      let operation;
      if (action === "retry") {
        operation = store.getOperation(id);
        if (operation.checkpoint.sessionId !== context.session.sessionId) throw new Error("Restore is outside this conversation.");
        if (operation.stage === "forking") {
          write(`Restore ${operation.id} has an uncertain fork. Inspect child sessions titled restore:${operation.id}; manual engine recovery is required. No retry or new fork was attempted.\n`);
          return true;
        }
      } else {
        const view = await store.inspectCheckpoint(id);
        if (view.checkpoint.sessionId !== context.session.sessionId) throw new Error("Checkpoint is outside this conversation.");
        for (const file of view.files) {
          write(file.status === "available" ? `Current digest: ${file.expectedDigest}\n` + formatFileDiff(file)
            : `${sanitizeTerminalText(file.path)}: ${file.status}; restore blocked.\n`);
        }
        if (action === "review" || view.files.some(file => file.status !== "available")) return true;
        // The operator explicitly adopts this displayed preimage. Never refresh
        // digests after a conflict or substitute them during a retry.
        if ((await context.input.question("Review current contents and digests above. Type prepare to adopt these exact restore preconditions: ")).trim() !== "prepare") return true;
        const expected = Object.fromEntries(view.files.flatMap(file => file.status === "available" ? [[file.path, file.expectedDigest]] : []));
        operation = (await store.prepareRestore(id, expected)).operation;
      }
      write(`Restore operation ${operation.id} · ${operation.stage}\n`);
      const preview = await store.previewRestore(operation.id);
      for (const file of preview.files) write(formatFileDiff(file));
      write(`Proposal: ${preview.proposalId}\nRestoring forks the captured conversation; the original is retained.\n`);
      if ((await context.input.question("Type restore to apply this exact reviewed proposal (Enter leaves it pending): ")).trim() !== "restore") return true;
      const result = await store.applyRestore(operation.id, preview.proposalId);
      write(`Restore ${result.id}: ${result.stage}\n`);
      if (result.forkSessionId) fork = await context.sessions.get(result.forkSessionId);
    } else write('Use /checkpoint [capture [JSON paths]|list|review [id]|restore [id]|retry [operationId]].\n');
  } finally { store.close(); }
  if (fork) {
    await context.restoreSession(fork);
    write(`Restored conversation: ${fork.sessionId} (fork of ${context.session.sessionId}).\n`);
  }
  return true;
};
