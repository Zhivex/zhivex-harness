import { chmod, lstat, mkdir, open, readFile, realpath, rename, rm } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";

export const PROJECT_LIMIT = 8;

export interface RegisteredProject {
  path: string;
  name: string;
  addedAt: number;
  toolPolicy?: string;
}

export function defaultRegistryPath() {
  const override = process.env.ZHIVEX_PROJECT_REGISTRY;
  if (override) return path.resolve(override);
  return path.join(homedir(), ".zhivex", "projects.json");
}

function assertRecord(value: unknown): RegisteredProject {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("PROJECT_REGISTRY_UNSAFE");
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record);
  if (keys.some(key => !["path", "name", "addedAt", "toolPolicy"].includes(key))) throw new Error("PROJECT_REGISTRY_UNSAFE");
  if (typeof record.path !== "string" || !path.isAbsolute(record.path) || record.path.includes("\0")) throw new Error("PROJECT_REGISTRY_UNSAFE");
  if (typeof record.name !== "string" || !record.name || record.name.length > 256) throw new Error("PROJECT_REGISTRY_UNSAFE");
  if (typeof record.addedAt !== "number" || !Number.isSafeInteger(record.addedAt) || record.addedAt < 0) throw new Error("PROJECT_REGISTRY_UNSAFE");
  if (record.toolPolicy !== undefined && (typeof record.toolPolicy !== "string" || !path.isAbsolute(record.toolPolicy))) throw new Error("PROJECT_REGISTRY_UNSAFE");
  return {
    path: record.path,
    name: path.basename(record.path),
    addedAt: record.addedAt,
    ...(record.toolPolicy ? { toolPolicy: record.toolPolicy } : {}),
  };
}

async function assertPrivateFile(file: string) {
  const info = await lstat(file);
  if (info.isSymbolicLink() || !info.isFile() || info.nlink !== 1) throw new Error("PROJECT_REGISTRY_UNSAFE");
  if (process.getuid && info.uid !== process.getuid()) throw new Error("PROJECT_REGISTRY_UNSAFE");
  if ((info.mode & 0o077) !== 0) throw new Error("PROJECT_REGISTRY_UNSAFE");
  if ((await realpath(file)) !== file) throw new Error("PROJECT_REGISTRY_UNSAFE");
}

export async function readProjectRegistry(file = defaultRegistryPath()): Promise<RegisteredProject[]> {
  try {
    await assertPrivateFile(file);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
  const parsed = JSON.parse(await readFile(file, "utf8")) as unknown;
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("PROJECT_REGISTRY_UNSAFE");
  const body = parsed as Record<string, unknown>;
  if (body.schemaVersion !== 1 || !Array.isArray(body.projects) || Object.keys(body).some(key => !["schemaVersion", "projects"].includes(key))) {
    throw new Error("PROJECT_REGISTRY_UNSAFE");
  }
  if (body.projects.length > PROJECT_LIMIT) throw new Error("PROJECT_REGISTRY_UNSAFE");
  const projects = body.projects.map(assertRecord);
  if (new Set(projects.map(project => project.path)).size !== projects.length) throw new Error("PROJECT_REGISTRY_UNSAFE");
  return projects;
}

export async function writeProjectRegistry(projects: RegisteredProject[], file = defaultRegistryPath()) {
  if (projects.length > PROJECT_LIMIT) throw new Error("PROJECT_LIMIT");
  const directory = path.dirname(file);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  await chmod(directory, 0o700);
  const temporary = path.join(directory, `.projects-${process.pid}.tmp`);
  const payload = JSON.stringify({ schemaVersion: 1, projects }, null, 2) + "\n";
  const handle = await open(temporary, "w", 0o600);
  try {
    await handle.writeFile(payload);
    await handle.sync();
  } finally {
    await handle.close();
  }
  await chmod(temporary, 0o600);
  await rename(temporary, file);
  await chmod(file, 0o600);
}

export async function resolveProjectDirectory(directory: string) {
  const resolved = await realpath(path.resolve(directory));
  const info = await lstat(resolved);
  if (!info.isDirectory() || info.isSymbolicLink()) throw new Error("PROJECT_PATH_INVALID");
  return resolved;
}

export async function addRegisteredProject(directory: string, options: {
  file?: string;
  confirm: (folder: string) => Promise<boolean> | boolean;
  toolPolicy?: string;
  now?: number;
}) {
  const folder = await resolveProjectDirectory(directory);
  if (!(await options.confirm(folder))) throw new Error("PROJECT_CONFIRMATION_MISMATCH");
  let toolPolicy: string | undefined;
  if (options.toolPolicy) {
    const policy = await realpath(path.resolve(options.toolPolicy));
    const info = await lstat(policy);
    if (!info.isFile() || info.isSymbolicLink()) throw new Error("PROJECT_POLICY_INVALID");
    toolPolicy = policy;
  }
  const file = options.file ?? defaultRegistryPath();
  const projects = await readProjectRegistry(file);
  const existing = projects.find(project => project.path === folder);
  if (existing) {
    // Re-adding without a policy keeps the stored one. A new policy must hit disk
    // before the CLI reports success, or the web runtime keeps the old file.
    if (!toolPolicy || existing.toolPolicy === toolPolicy) return projects;
    const next = projects.map(project => project.path === folder ? { ...project, toolPolicy } : project);
    await writeProjectRegistry(next, file);
    return next;
  }
  if (projects.length >= PROJECT_LIMIT) throw new Error("PROJECT_LIMIT");
  const next = [...projects, {
    path: folder,
    name: path.basename(folder),
    addedAt: options.now ?? Date.now(),
    ...(toolPolicy ? { toolPolicy } : {}),
  }];
  await writeProjectRegistry(next, file);
  return next;
}

export async function removeRegisteredProject(directory: string, options: {
  file?: string;
  confirm: (folder: string) => Promise<boolean> | boolean;
}) {
  const folder = await resolveProjectDirectory(directory);
  if (!(await options.confirm(folder))) throw new Error("PROJECT_CONFIRMATION_MISMATCH");
  const file = options.file ?? defaultRegistryPath();
  const projects = await readProjectRegistry(file);
  const next = projects.filter(project => project.path !== folder);
  await writeProjectRegistry(next, file);
  return next;
}

export async function removeRegisteredPath(folder: string, file = defaultRegistryPath()) {
  const projects = await readProjectRegistry(file);
  await writeProjectRegistry(projects.filter(project => project.path !== folder), file);
}

export function projectFailureCause(code: string, folder: string) {
  if (code === "ENOENT" || code === "WEB_WORKSPACE_INVALID" || code === "PROJECT_PATH_INVALID") {
    return `The folder is no longer at ${folder}.`;
  }
  if (code === "WEB_CREDENTIALS_REQUIRED") return "Provider credentials are missing. Configure them in the CLI.";
  return "This project could not be opened. Other projects are unaffected.";
}

export interface ActiveProject {
  path: string;
  source: "flag" | "registry";
  toolPolicy?: string;
}

export interface RegistrySyncPlan {
  start: RegisteredProject[];
  detach: string[];
  unavailable: { project: RegisteredProject; cause: string }[];
  /** Registry projects already open whose stored policy differs from the running runtime. */
  refresh: RegisteredProject[];
}

/** Decide which registered folders to open. Explicit flag workspaces are never detached. */
export function planRegistrySync(active: ActiveProject[], registry: RegisteredProject[] | undefined, limit = PROJECT_LIMIT): RegistrySyncPlan {
  if (!registry) return { start: [], detach: [], unavailable: [], refresh: [] };
  const registered = new Set(registry.map(project => project.path));
  const activeByPath = new Map(active.map(project => [project.path, project]));
  const detach = active.filter(project => project.source === "registry" && !registered.has(project.path)).map(project => project.path);
  const room = Math.max(0, limit - (active.length - detach.length));
  const start: RegisteredProject[] = [];
  const refresh: RegisteredProject[] = [];
  const unavailable: RegistrySyncPlan["unavailable"] = [];
  for (const project of registry) {
    const current = activeByPath.get(project.path);
    if (current && !detach.includes(project.path)) {
      // Flag workspaces keep the explicit --tool-policy. Registry workspaces follow the file.
      if (current.source === "registry" && (current.toolPolicy ?? "") !== (project.toolPolicy ?? "")) refresh.push(project);
      continue;
    }
    if (start.length < room) start.push(project);
    else unavailable.push({ project, cause: `The local engine is already serving ${limit} projects. Remove one to open this project.` });
  }
  return { start, detach, unavailable, refresh };
}

export async function safeRegistryRead(file = defaultRegistryPath()) {
  try {
    return await readProjectRegistry(file);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    return undefined;
  }
}

export async function discardTemporaryRegistry(file: string) {
  await rm(file, { force: true });
}
