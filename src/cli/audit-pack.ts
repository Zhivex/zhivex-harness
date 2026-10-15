import path from "node:path";
import type { HarnessConfig } from "../runtime/config.js";
import { resolveHarnessConfig } from "../runtime/config.js";
import { openHarnessPersistence } from "../persistence/operations.js";
import { validateStateDirectory } from "../persistence/state-directory.js";
import { openCliSessionStore } from "../persistence/sessions.js";
import { openHarnessActivityStore } from "../client/service-events.js";
import { exportHarnessAuditPack, loadAuditSigningKey, verifyHarnessAuditPack } from "../audit/index.js";
import { CliUsageError, type CliOptions } from "./arguments.js";

const signingKey = async (file: string | undefined) => {
  if (!file && process.env.ZHIVEX_AUDIT_SIGNING_KEY === undefined) {
    throw new CliUsageError("Set ZHIVEX_AUDIT_SIGNING_KEY or pass --signing-key-file. The key is not stored in the pack.");
  }
  try {
    return await loadAuditSigningKey({ ...(file ? { file } : {}), ...(file ? {} : { value: process.env.ZHIVEX_AUDIT_SIGNING_KEY ?? "" }) });
  } catch (error) {
    if (error instanceof Error && (error.message === "AUDIT_PACK_KEY_INVALID" || error.name === "UnsafeFileTypeError" || error.name === "FileSizeLimitError")) {
      throw new CliUsageError("Audit signing key must be a regular file or environment value of 32 to 4096 bytes.");
    }
    throw error;
  }
};

/** Experimental operator command. Verification reads the pack and key only. Export reads durable state and writes a new directory. */
export async function auditPackCli(options: CliOptions) {
  const key = await signingKey(options.signingKeyFile);
  if (options.command === "verify-audit") {
    const result = await verifyHarnessAuditPack({ directory: path.resolve(options.auditOut!), signingKey: key });
    process.stdout.write(options.json
      ? `${JSON.stringify(result, null, 2)}\n`
      : `Audit pack verified: ${result.subject.kind} ${result.subject.id} (${result.fileCount} files, key ${result.keyId}).\n`);
    return result;
  }
  const config: HarnessConfig = resolveHarnessConfig(options);
  await validateStateDirectory(config.workspace, config.stateDirectory);
  const persistence = await openHarnessPersistence(config);
  let index: Awaited<ReturnType<typeof openCliSessionStore>> | undefined;
  let history: Awaited<ReturnType<typeof openHarnessActivityStore>> | undefined;
  try {
    if (options.sessionId) {
      index = await openCliSessionStore({ workspace: config.workspace, stateDirectory: config.stateDirectory, scope: config.scope });
      history = await openHarnessActivityStore(config);
    }
    const manifest = await exportHarnessAuditPack({
      store: persistence.store,
      scope: config.scope,
      subjectId: options.runId!,
      directory: path.resolve(options.auditOut!),
      signingKey: key,
      config,
      ...(index && history && options.sessionId ? { session: { id: options.sessionId, index, history } } : {})
    });
    process.stdout.write(options.json
      ? `${JSON.stringify(manifest, null, 2)}\n`
      : `Audit pack written to ${path.resolve(options.auditOut!)} (${manifest.subject.kind} ${manifest.subject.id}, ${manifest.files.length} files).\n`);
    return manifest;
  } finally {
    history?.close();
    index?.close();
    persistence.close();
  }
}
