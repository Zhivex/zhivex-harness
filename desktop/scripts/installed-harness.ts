import { createHash } from "node:crypto";
import { readFile, realpath } from "node:fs/promises";
import path from "node:path";

/** Both build and packaging consume this exact installed candidate. No source fallback. */
export async function installedHarness(root: string) {
  const marker = JSON.parse(await readFile(path.join(root, ".harness/installed.json"), "utf8"));
  if (marker.schemaVersion !== 1 || !/^[a-f0-9]{64}$/.test(marker.sha256)) throw new Error("Run prepare:harness with a verified candidate tarball.");
  const install = path.join(root, ".harness", marker.sha256);
  if (marker.install !== install) throw new Error("Installed Harness candidate path mismatch.");
  const sha256 = createHash("sha256").update(await readFile(path.join(install, "harness.tgz"))).digest("hex");
  if (sha256 !== marker.sha256) throw new Error("Installed Harness artifact changed.");
  const packageRoot = await realpath(path.join(root, "node_modules/@zhivex-ai/harness"));
  if (!packageRoot.startsWith(await realpath(install) + path.sep)) throw new Error("Harness must come from the prepared installation, not a source link.");
  if (packageRoot !== await realpath(path.join(install, "node_modules/@zhivex-ai/harness"))) throw new Error("Desktop dependency differs from the prepared candidate.");
  const metadata = JSON.parse(await readFile(path.join(packageRoot, "package.json"), "utf8"));
  const desktop = JSON.parse(await readFile(path.join(root, "package.json"), "utf8"));
  if (metadata.name !== "@zhivex-ai/harness" || metadata.version !== marker.version || metadata.version !== desktop.harness?.version) throw new Error("Installed Harness version or package identity mismatch.");
  return { metadata, sha256, nodeModules: path.join(install, "node_modules") };
}
