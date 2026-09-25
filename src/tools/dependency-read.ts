import path from "node:path";
import { lstat } from "node:fs/promises";
import { createHash } from "node:crypto";
import { z } from "zod";
import { readRegularFileNoFollow } from "../workspace/file-security.js";

export const dependencyReadSchema = z.object({
  package: z.string().max(160).regex(/^(?:@[a-z0-9_-]+\/)?[a-z0-9][a-z0-9._-]*$/),
  file: z.string().max(400).default("package.json"),
  startLine: z.number().int().min(1).default(1)
});

/** Dedicated read-only boundary. No arbitrary dependency source, scripts, links,
 * nested packages or writes; exports are available through package.json. */
export async function readDependency(root: string, input: z.infer<typeof dependencyReadSchema>) {
  const { package: name, file, startLine } = dependencyReadSchema.parse(input);
  const segments = file.split("/");
  if (segments.some(p => !p || p === "." || p === ".." || p.startsWith(".") || p === "node_modules" || p.includes("\\") || p.includes("\0")) ||
      !(file === "package.json" || /\.d\.(?:ts|mts|cts)$/.test(file))) {
    throw new Error("Dependency access only permits package.json and TypeScript declaration files.");
  }
  const relative = ["node_modules", ...name.split("/"), ...segments];
  const ancestors: { target: string; dev: number; ino: number; ctimeMs: number }[] = [];
  let target = root;
  for (const segment of relative.slice(0, -1)) {
    target = path.join(target, segment);
    const entry = await lstat(target);
    if (!entry.isDirectory() || entry.isSymbolicLink()) throw new Error("Dependency directory links are not allowed.");
    ancestors.push({ target, dev: entry.dev, ino: entry.ino, ctimeMs: entry.ctimeMs });
  }
  const result = await readRegularFileNoFollow(path.join(target, relative.at(-1)!), {
    label: "Dependency metadata", maxBytes: 1024 * 1024, requireSingleLink: true
  });
  for (const entry of ancestors) {
    const current = await lstat(entry.target);
    if (!current.isDirectory() || current.dev !== entry.dev || current.ino !== entry.ino || current.ctimeMs !== entry.ctimeMs)
      throw new Error("Dependency directory changed during inspection.");
  }
  const text = new TextDecoder("utf-8", { fatal: true }).decode(result.contents);
  if (text.includes("\0")) throw new Error("Dependency metadata must be UTF-8 text.");
  const lines = text.split("\n");
  const content = lines.slice(startLine - 1, startLine + 199).join("\n").slice(0, 16000);
  return { package: name, file, startLine, content,
    digest: "sha256:" + createHash("sha256").update(result.contents).digest("hex"),
    truncated: startLine + 199 < lines.length || content.length >= 16000 };
}
