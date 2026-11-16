import { createHash, randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdir, lstat, realpath, open, rename, unlink } from "node:fs/promises";
import { constants } from "node:fs";
import path from "node:path";
import { z } from "zod";
import type { DesktopProject } from "./bridge.js";
import { modelSelectionSchema } from "./model-selection.js";
const execute = promisify(execFile);
const projectSchema = z.object({ key: z.string().regex(/^project_[a-f0-9]{32}$/), workspace: z.string().min(1).max(4096), name: z.string().min(1).max(4096), modelSelection: modelSelectionSchema.optional(), lastOpenedAt: z.number().int().nonnegative() }).strict();
const schema = z.object({ schemaVersion: z.literal(1), projects: z.array(projectSchema).max(100) }).strict();
export async function openProjectRegistry(directory: string) {
    await mkdir(directory, { recursive: true, mode: 0o700 });
    const info = await lstat(directory); if (!info.isDirectory() || info.isSymbolicLink() || info.uid !== process.getuid?.() || (info.mode & 0o077) !== 0) throw new Error("PROJECT_DIRECTORY_UNSAFE");
    const filename = path.join(await realpath(directory), "projects.json");
    let projects: DesktopProject[] = [];
    try {
        const file = await open(filename, constants.O_RDONLY | constants.O_NOFOLLOW);
        try { const stat = await file.stat(); if (!stat.isFile() || stat.uid !== process.getuid?.() || (stat.mode & 0o077) !== 0 || stat.size > 128 * 1024) throw new Error("PROJECT_INDEX_UNSAFE"); projects = schema.parse(JSON.parse(await file.readFile("utf8"))).projects; } finally { await file.close(); }
    } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
    const key = (workspace: string) => `project_${createHash("sha256").update(workspace).digest("hex").slice(0, 32)}`;
    if (projects.some(p => !path.isAbsolute(p.workspace) || key(p.workspace) !== p.key) || new Set(projects.map(p => p.key)).size !== projects.length) throw new Error("PROJECT_INDEX_INVALID");
    let writes = Promise.resolve();
    const persist = async (next: DesktopProject[]) => {
        const contents = JSON.stringify({schemaVersion: 1, projects: next});
        if (Buffer.byteLength(contents) > 128 * 1024) throw new Error("PROJECT_INDEX_LIMIT");
        const temporary = filename + `.${randomUUID()}.tmp`;
        const file = await open(temporary, "wx", 0o600);
        try { await file.writeFile(contents); await file.sync(); } finally { await file.close(); }
        try { await rename(temporary, filename); projects = next; }
        finally { await unlink(temporary).catch(error => { if (error.code !== "ENOENT") throw error; }); }
    };
    const serial = (operation: () => Promise<void>) => { const saved = writes.then(operation); writes = saved.catch(() => {}); return saved; };

    return {
        list: () => structuredClone(projects).sort((a, b) => b.lastOpenedAt - a.lastOpenedAt),
        get: (id: string) => { const p = projects.find(p => p.key === id); if (!p) throw new Error("PROJECT_NOT_FOUND"); return structuredClone(p); },
        async select(selected: string) {
            const directory = await realpath(selected);
            if (!(await lstat(directory)).isDirectory()) throw new Error("PROJECT_NOT_DIRECTORY");
            // Read-only Git discovery: never executes a hook, switches branches or copies changes.
            const result = await execute("git", ["-C", directory, "rev-parse", "--show-toplevel"], { timeout: 5000, maxBuffer: 8192, env: { PATH: process.env.PATH, HOME: process.env.HOME, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null" } }).catch(() => { throw new Error("PROJECT_NOT_REPOSITORY"); });
            const workspace = await realpath(result.stdout.trim());
            const project: DesktopProject = { key: key(workspace), workspace, name: path.basename(workspace) || workspace, lastOpenedAt: Date.now() };
            await serial(async () => {
                const previous = projects.find(p => p.key === project.key);
                if (previous?.modelSelection) project.modelSelection = previous.modelSelection;
                await persist([project, ...projects.filter(p => p.key !== project.key)].slice(0, 100));
            });
            return structuredClone(project);
        },
        async setModel(id: string, value: unknown) {
            const modelSelection = modelSelectionSchema.parse(value);
            await serial(async () => {
                if (!projects.some(p => p.key === id)) throw new Error("PROJECT_NOT_FOUND");
                await persist(projects.map(p => p.key === id ? {...p, modelSelection} : p));
            });
            return structuredClone(projects.find(p => p.key === id)!);
        }
    };
}
