import { writeFile } from "node:fs/promises";
import path from "node:path";

import {
  buildStableApiSignatureSnapshot,
  emitWorkspaceDeclarations,
  readPublicApiStabilityContract
} from "./stable-api-signatures.js";

const workspace = path.resolve(import.meta.dir, "..");
const output = path.join(workspace, "contracts", "stable-api-signatures.json");
const emitted = await emitWorkspaceDeclarations(workspace);
try {
  const contract = await readPublicApiStabilityContract(path.join(workspace, "contracts", "public-api.json"));
  const snapshot = buildStableApiSignatureSnapshot(emitted.entry, contract);
  const serialized = `${JSON.stringify(snapshot, null, 2)}\n`;
  if (process.argv.includes("--write")) {
    await writeFile(output, serialized, "utf8");
    process.stdout.write(`Updated ${path.relative(workspace, output)} (${snapshot.digest}).\n`);
  } else {
    process.stdout.write(serialized);
  }
} finally {
  await emitted.cleanup();
}
