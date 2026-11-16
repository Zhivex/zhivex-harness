import { access } from "node:fs/promises";
import path from "node:path";

/** Runtime contracts required by the Electron application, including its unified host. */
export const requiredHarnessExports = [
  "./engine", "./protocol", "./service", "./models",
  "./desktop/v1/state", "./desktop/v1/providers",
  "./application", "./application/client", "./application/protocol",
  "./assistant/managed/setup"
] as const;

export async function validateHarnessExports(packageRoot: string, metadata: {
  exports?: Record<string, {import?: string; types?: string}>;
}) {
  for (const subpath of requiredHarnessExports) {
    const entry = metadata.exports?.[subpath];
    if (!entry?.import || !entry.types) throw new Error(`Harness candidate is missing required Desktop contract ${subpath}.`);
    for (const filename of [entry.import, entry.types]) {
      const resolved = path.resolve(packageRoot, filename);
      if (!resolved.startsWith(path.resolve(packageRoot) + path.sep)) throw new Error(`Harness contract ${subpath} escapes its package.`);
      await access(resolved);
    }
  }
}
