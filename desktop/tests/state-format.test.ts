import {test, expect} from "bun:test";
import {mkdtemp, mkdir, readFile, readdir, rm, stat, symlink, writeFile} from "node:fs/promises";
import path from "node:path";
import {tmpdir} from "node:os";
import {checkDesktopStateFormat} from "../src/state-format.js";
async function fixture(run: (directory: string, filename: string) => Promise<void>) {
 const directory = await mkdtemp(path.join(tmpdir(), "har-state-format-"));
 const root = path.join(directory, "state-compatibility"), filename = path.join(root, "format.json");
 await mkdir(root, {mode: 0o700});
 try {await run(directory, filename);} finally {await rm(directory, {recursive: true, force: true});}
}
test("legacy state acquires a private marker without changing project files; concurrent starts agree", () => fixture(async (directory, filename) => {
 await writeFile(path.join(directory, "projects.json"), "existing state");
 await Promise.all([checkDesktopStateFormat(directory), checkDesktopStateFormat(directory)]);
 expect(JSON.parse(await readFile(filename, "utf8"))).toEqual({format: 1, phase: "ready"});
 expect((await stat(filename)).mode & 0o777).toBe(0o600);
 expect(await readFile(path.join(directory, "projects.json"), "utf8")).toBe("existing state");
 expect(await readdir(path.dirname(filename))).toEqual(["format.json"]);
}));
test("older format reader rejects newer state without resetting its marker", () => fixture(async (directory, filename) => {
 const value = JSON.stringify({format: 2, phase: "ready"}); await writeFile(filename, value, {mode: 0o600});
 await expect(checkDesktopStateFormat(directory)).rejects.toThrow("DESKTOP_STATE_INCOMPATIBLE");
 expect(await readFile(filename, "utf8")).toBe(value);
}));
test("interrupted migration requires explicit recovery", () => fixture(async (directory, filename) => {
 const value = JSON.stringify({format: 1, phase: "migrating"}); await writeFile(filename, value, {mode: 0o600});
 await expect(checkDesktopStateFormat(directory)).rejects.toThrow("DESKTOP_STATE_RECOVERY_REQUIRED");
 expect(await readFile(filename, "utf8")).toBe(value);
}));
test("invalid or oversized state yields only a sanitized diagnostic", () => fixture(async (directory, filename) => {
 for (const value of ["private path or secret", "x".repeat(1025), '{"format":1,"phase":"ready","injected":true}']) {
  await writeFile(filename, value, {mode: 0o600});
  await expect(checkDesktopStateFormat(directory)).rejects.toThrow("DESKTOP_STATE_INVALID");
  expect(await readFile(filename, "utf8")).toBe(value);
 }
}));
test("symlinked marker is never followed or replaced", () => fixture(async (directory, filename) => {
 const target = path.join(directory, "target"); await writeFile(target, '{"format":1,"phase":"ready"}', {mode: 0o600}); await symlink(target, filename);
 await expect(checkDesktopStateFormat(directory)).rejects.toThrow("DESKTOP_STATE_INVALID");
 expect(await readFile(target, "utf8")).toBe('{"format":1,"phase":"ready"}');
}));
