import { constants } from "node:fs";
import { lstat, open, realpath, rename, unlink } from "node:fs/promises";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { readRegularFileNoFollow } from "@zhivex-ai/harness/desktop/v1/state";
import { emptyLimitSettings, validateLimitSettings, type LimitScope, type LimitSettings } from "./limit-settings.js";
import { validateRunLimits, type RunLimits } from "./limit-observer.js";

export type LimitPreferences = { schemaVersion: 1; revision: number; project: LimitSettings; task: LimitSettings | null };
const validPreferences = (value: unknown): value is LimitPreferences => {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const v = value as LimitPreferences;
  return Object.keys(v).sort().join(",") === "project,revision,schemaVersion,task" && v.schemaVersion === 1 &&
    Number.isSafeInteger(v.revision) && v.revision >= 0 && validateLimitSettings(v.project) && (v.task === null || validateLimitSettings(v.task));
};

/** Private, scope-bound preferences; never a browser-selected path or credential store. */
export class WebLimitStore {
  private pending: Promise<unknown> = Promise.resolve();
  readonly filename: string;
  constructor(private directory: string, identity: unknown) {
    this.filename = path.join(directory, `web-limits-${createHash("sha256").update(JSON.stringify(identity)).digest("hex").slice(0, 20)}.json`);
  }
  private async parent() {
    const resolved = await realpath(this.directory);
    if (resolved !== path.resolve(this.directory)) throw new Error("WEB_LIMIT_STORAGE_UNSAFE");
    const info = await lstat(this.directory);
    if (!info.isDirectory() || info.isSymbolicLink() || info.uid !== process.getuid?.() || (info.mode & 0o077)) throw new Error("WEB_LIMIT_STORAGE_UNSAFE");
    return { ino: info.ino, dev: info.dev };
  }
  async read(): Promise<LimitPreferences> {
    await this.parent();
    try {
      const result = await readRegularFileNoFollow(this.filename, { label: "WEB_LIMIT_STORAGE_UNSAFE", maxBytes: 16 * 1024, requireSingleLink: true });
      if (result.stat.uid !== process.getuid?.() || (result.stat.mode & 0o077)) throw new Error("WEB_LIMIT_STORAGE_UNSAFE");
      const parsed: unknown = JSON.parse(result.contents.toString("utf8"));
      if (!validPreferences(parsed)) throw new Error("WEB_LIMIT_SETTINGS_INVALID");
      return parsed;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      return { schemaVersion: 1, revision: 0, project: emptyLimitSettings(), task: null };
    }
  }
  private serial<T>(job: () => Promise<T>): Promise<T> {
    const next = this.pending.then(job);
    this.pending = next.catch(() => {});
    return next;
  }
  private async write(value: unknown, filename = this.filename) {
    const parent = await this.parent();
    const temp = path.join(this.directory, `.web-limits-${randomUUID()}.tmp`);
    const file = await open(temp, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW, 0o600);
    try {
      const contents = JSON.stringify(value);
      if (Buffer.byteLength(contents) > (filename === this.filename ? 16 * 1024 : 4 * 1024 * 1024)) throw new Error("WEB_LIMIT_STORAGE_UNSAFE");
      await file.writeFile(contents);
      await file.sync();
      await file.close();
      const current = await this.parent();
      if (current.ino !== parent.ino || current.dev !== parent.dev) throw new Error("WEB_LIMIT_STORAGE_UNSAFE");
      // Re-read through the existing no-follow primitive before replacement.
      try {
        const target = await readRegularFileNoFollow(filename, { label: "WEB_LIMIT_STORAGE_UNSAFE", maxBytes: filename === this.filename ? 16 * 1024 : 4 * 1024 * 1024, requireSingleLink: true });
        if (target.stat.uid !== process.getuid?.() || (target.stat.mode & 0o077)) throw new Error("WEB_LIMIT_STORAGE_UNSAFE");
      } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
      await rename(temp, filename);
    } finally { await file.close().catch(() => {}); await unlink(temp).catch(error => { if (error.code !== "ENOENT") throw error; }); }
  }
  save(scope: LimitScope, settings: LimitSettings, expectedRevision: number) {
    return this.serial(async () => {
      if (!validateLimitSettings(settings)) throw new Error("WEB_LIMIT_SETTINGS_INVALID");
      const previous = await this.read();
      if (previous.revision !== expectedRevision) throw new Error("WEB_LIMIT_REVISION_CONFLICT");
      const next = { ...previous, revision: previous.revision + 1, [scope]: structuredClone(settings) };
      await this.write(next);
      return next;
    });
  }
  admit() {
    return this.serial(async () => {
      const previous = await this.read();
      const origin = previous.task !== null ? "task" : Object.values(previous.project).some(t => t.value !== null) ? "project" : "default";
      const settings = structuredClone(previous.task ?? previous.project);
      if (previous.task !== null) await this.write({ ...previous, task: null, revision: previous.revision + 1 });
      return { settings, origin } as const;
    });
  }
  private runFile(runId: string) {
    if (!/^run_[A-Za-z0-9-]{1,80}$/.test(runId)) throw new Error("WEB_LIMIT_RUN_INVALID");
    return path.join(this.directory, `${path.basename(this.filename, ".json")}-${runId}.json`);
  }
  async readRun(runId: string): Promise<RunLimits | null> {
    await this.parent();
    try {
      const result = await readRegularFileNoFollow(this.runFile(runId), { label: "WEB_LIMIT_STORAGE_UNSAFE", maxBytes: 4 * 1024 * 1024, requireSingleLink: true });
      if (result.stat.uid !== process.getuid?.() || (result.stat.mode & 0o077)) throw new Error("WEB_LIMIT_STORAGE_UNSAFE");
      const parsed = JSON.parse(result.contents.toString("utf8")) as RunLimits;
      if (!validateRunLimits(parsed) || parsed.runId !== runId) throw new Error("WEB_LIMIT_SETTINGS_INVALID");
      return parsed;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      return null;
    }
  }
  saveRun(run: RunLimits) {
    if (!validateRunLimits(run)) return Promise.reject(new Error("WEB_LIMIT_SETTINGS_INVALID"));
    return this.serial(() => this.write(run, this.runFile(run.runId)));
  }
}
