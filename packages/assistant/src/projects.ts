import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { mkdir, lstat, realpath, open, rename, unlink } from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import path from "node:path";
import { z } from "zod";
import { syncPrivateDirectory } from "./private-directory.js";

const execute = promisify(execFile);
export const projectKey = (workspace: string) => `project_${createHash("sha256").update(workspace).digest("hex").slice(0, 32)}`;
const project = z.object({ projectKey: z.string(), name: z.string().min(1).max(4096), canonicalPath: z.string().min(1).max(4096) }).strict();
const binding = z.object({ conversationId: z.string(), runtimeId: z.string(), engineProjectId: z.string(), sessionId: z.string(), context: z.discriminatedUnion("kind", [z.object({ kind: z.literal("general") }).strict(), z.object({ kind: z.literal("project"), projectKey: z.string() }).strict()]) }).strict();
const indexSchema = z.object({ schemaVersion: z.literal(1), projects: z.array(project).max(100), conversations: z.array(binding).max(2000) }).strict();

export async function ensureProjectPrivateDirectory(directory: string) {
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const stat = await lstat(directory);
  if (!stat.isDirectory() || stat.isSymbolicLink() || stat.uid !== process.getuid?.() || (stat.mode & 0o077)) throw new Error("PROJECT_DIRECTORY_UNSAFE");
  return realpath(directory);
}

async function readPrivate(filename: string) {
  const file = await open(filename, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const stat = await file.stat();
    if (!stat.isFile() || stat.uid !== process.getuid?.() || (stat.mode & 0o077) || stat.size > 1024 * 1024) throw new Error("PROJECT_STATE_UNSAFE");
    return await file.readFile("utf8");
  } finally { await file.close(); }
}

/** Adapted from Desktop's canonical Git selection and atomic private index. */
export async function canonicalProject(selected: string) {
  const directory = await realpath(selected);
  if (!(await lstat(directory)).isDirectory()) throw new Error("PROJECT_NOT_DIRECTORY");
  const result = await execute("git", ["-C", directory, "rev-parse", "--show-toplevel"], {
    timeout: 5000, maxBuffer: 8192,
    env: { PATH: process.env.PATH, HOME: process.env.HOME, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null" },
  }).catch(() => { throw new Error("PROJECT_NOT_REPOSITORY"); });
  const canonicalPath = await realpath(result.stdout.trim());
  return { projectKey: projectKey(canonicalPath), name: path.basename(canonicalPath), canonicalPath };
}

export async function openAssistantProjectRegistry(directory: string) {
  const root = await ensureProjectPrivateDirectory(directory), filename = path.join(root, "projects.json");
  let state: z.infer<typeof indexSchema> = { schemaVersion: 1, projects: [], conversations: [] };
  try { state = indexSchema.parse(JSON.parse(await readPrivate(filename))); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  if (state.projects.some(p => !path.isAbsolute(p.canonicalPath) || projectKey(p.canonicalPath) !== p.projectKey) || new Set(state.projects.map(p => p.projectKey)).size !== state.projects.length || new Set(state.conversations.map(c => c.conversationId)).size !== state.conversations.length || state.conversations.some(c => c.context.kind === "project" && !state.projects.some(p => p.projectKey === (c.context as { projectKey: string }).projectKey))) throw new Error("PROJECT_INDEX_INVALID");
  let tail = Promise.resolve();
  const save = (change: (next: typeof state) => void) => {
    const operation = tail.then(async () => {
      const next = structuredClone(state); change(next); indexSchema.parse(next);
      const contents = JSON.stringify(next);
      if (Buffer.byteLength(contents) > 1024 * 1024) throw new Error("PROJECT_INDEX_LIMIT");
      const temp = `${filename}.${randomUUID()}.tmp`, file = await open(temp, "wx", 0o600);
      try {
        await file.writeFile(contents); await file.sync(); await file.close();
        await rename(temp, filename); state = next; await syncPrivateDirectory(root, "PROJECT_DIRECTORY_UNSAFE");
      } finally { await file.close(); await unlink(temp).catch(e => { if (e.code !== "ENOENT") throw e; }); }
    });
    tail = operation.catch(() => {}); return operation;
  };
  return {
    projects: () => structuredClone(state.projects),
    conversations: () => structuredClone(state.conversations),
    async register(value: z.infer<typeof project>) { await save(next => { if (!next.projects.some(p => p.projectKey === value.projectKey)) next.projects.push(value); }); return structuredClone(value); },
    async bind(value: z.infer<typeof binding>) {
      await save(next => {
        const old = next.conversations.find(c => c.conversationId === value.conversationId);
        if (old && JSON.stringify(old) !== JSON.stringify(value)) throw new Error("BINDING_MISMATCH");
        if (!old) next.conversations.push(value);
      });
      return structuredClone(value);
    },
    async pinConfiguration(key: string, digest: string) {
      const filename = path.join(root, `${key}.binding`);
      try { const file = await open(filename, "wx", 0o600); try { await file.writeFile(digest); await file.sync(); } finally { await file.close(); } }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error; if (await readPrivate(filename) !== digest) throw new Error("BINDING_MISMATCH"); }
    },
  };
}

/** Lock before opening any project database; all Assistant hosts share this location. */
export async function acquireAssistantProjectOwner(workspace: string, recover: boolean, externalDirectory?: string) {
  const root = await ensureProjectPrivateDirectory(externalDirectory ?? path.join(workspace, ".zhivex-harness"));
  const filename = path.join(root, "assistant-owner.json"), gate = filename + ".claim";
  const claim = await open(gate, "wx", 0o600).catch(() => { throw new Error("OWNERSHIP_CONFLICT"); });
  const token = randomUUID();
  try {
    try {
      const previous = z.object({ pid: z.number().int().positive(), token: z.string().uuid() }).strict().parse(JSON.parse(await readPrivate(filename)));
      if (!recover) throw new Error("OWNERSHIP_CONFLICT");
      try { process.kill(previous.pid, 0); throw new Error("OWNERSHIP_CONFLICT"); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error; }
      await unlink(filename);
    } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
    const file = await open(filename, "wx", 0o600);
    try { await file.writeFile(JSON.stringify({ pid: process.pid, token })); await file.sync(); } finally { await file.close(); }
    await syncPrivateDirectory(root, "PROJECT_DIRECTORY_UNSAFE");
  } finally { await claim.close(); await unlink(gate); }
  return async () => {
    const current = JSON.parse(await readPrivate(filename));
    if (current.token !== token) throw new Error("OWNERSHIP_CONFLICT");
    await unlink(filename); await syncPrivateDirectory(root, "PROJECT_DIRECTORY_UNSAFE");
  };
}
