import { afterEach, expect, test } from "bun:test";
import { chmod, lstat, mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { selectWebServiceDirectory, webStartupDiagnostic } from "../src/service-directory.js";

const roots: string[] = [];
const name = `zhivex-code-web-${process.getuid?.() ?? "user"}`;
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, {recursive: true, force: true}))); });
async function fixture(bytes = 102) {
  const root = await realpath(await mkdtemp("/tmp/zwdir-")); roots.push(root);
  const suffix = `/${name}/${"0".repeat(20)}.sock`;
  const temp = root + "/" + "t".repeat(bytes - Buffer.byteLength(root + "/" + suffix));
  await mkdir(temp, {mode: 0o700});
  const short = root + "/s"; await mkdir(short, {mode: 0o700});
  return {root,temp,short,preferred:path.join(temp,name),fallback:path.join(short,name)};
}

test("canonical socket at 100 bytes retains preferred location and existing state", async () => {
  const f = await fixture(100);
  await mkdir(f.preferred,{mode:0o700});
  await writeFile(f.preferred + "/owner.lock", "unchanged", {mode:0o600});
  expect(await selectWebServiceDirectory(f.temp,f.short)).toBe(f.preferred);
  expect(await readFile(f.preferred + "/owner.lock", "utf8")).toBe("unchanged");
});

test("101/102-byte preferred sockets use a stable owner-private short directory", async () => {
  for (const bytes of [101,102]) {
    const f = await fixture(bytes);
    expect(await selectWebServiceDirectory(f.temp,f.short)).toBe(f.fallback);
    expect(await selectWebServiceDirectory(f.temp,f.short)).toBe(f.fallback);
    const stat = await lstat(f.fallback);
    expect(stat.mode & 0o777).toBe(0o700); expect(stat.uid === process.getuid?.()).toBe(true);
    expect(Buffer.byteLength(f.fallback + "/" + "0".repeat(20) + ".sock")).toBeLessThanOrEqual(100);
  }
});

test("canonical expansion and UTF-8 bytes govern the length check", async () => {
  const f = await fixture(100);
  const unicode=f.temp + "é"; await mkdir(unicode,{mode:0o700});
  const alias=f.short + "/alias"; await symlink(unicode,alias);
  expect(await selectWebServiceDirectory(alias,f.short)).toBe(f.fallback);
});

test("unsafe modes and final-directory symlinks fail closed in both locations", async () => {
  for (const location of ["preferred", "fallback"] as const) {
    const f = await fixture(); const target=f[location];
    await mkdir(target,{mode:0o700}); await chmod(target,0o755);
    await expect(selectWebServiceDirectory(f.temp,f.short)).rejects.toThrow("LOCAL_SERVICE_DIRECTORY_UNSAFE");
    expect((await lstat(target)).mode & 0o777).toBe(0o755);
    await rm(target,{recursive:true}); await symlink(f.root,target);
    await expect(selectWebServiceDirectory(f.temp,f.short)).rejects.toThrow("LOCAL_SERVICE_DIRECTORY_UNSAFE");
    expect((await lstat(target)).isSymbolicLink()).toBe(true);
  }
});

test("occupied long preferred location is never moved, erased or bypassed", async () => {
  const f = await fixture(); await mkdir(f.preferred,{mode:0o700});
  await writeFile(f.preferred + "/owner.lock", "preserve-owner", {mode:0o600});
  await expect(selectWebServiceDirectory(f.temp,f.short)).rejects.toThrow("WEB_SERVICE_LOCATION_OCCUPIED");
  expect(await readFile(f.preferred + "/owner.lock", "utf8")).toBe("preserve-owner");
  await expect(lstat(f.fallback)).rejects.toMatchObject({code:"ENOENT"});
});

test("existing fallback state remains for Harness owner/recovery enforcement", async () => {
  const f=await fixture(); await mkdir(f.fallback,{mode:0o700});
  await writeFile(f.fallback + "/owner.lock", "preserve-owner", {mode:0o600});
  expect(await selectWebServiceDirectory(f.temp,f.short)).toBe(f.fallback);
  expect(await readFile(f.fallback + "/owner.lock", "utf8")).toBe("preserve-owner");
});

test("even an overlong fallback fails without weakening the Harness limit", async () => {
  const f=await fixture(); const other=await fixture(103);
  await expect(selectWebServiceDirectory(f.temp,other.temp)).rejects.toThrow("LOCAL_SERVICE_SOCKET_PATH_TOO_LONG");
});

test("startup diagnostics reveal allowlisted codes only, never paths or arbitrary messages", () => {
  expect(webStartupDiagnostic(new Error("LOCAL_SERVICE_SOCKET_PATH_TOO_LONG"))).toBe("WEB_START_FAILED (LOCAL_SERVICE_SOCKET_PATH_TOO_LONG)");
  expect(webStartupDiagnostic(new Error("LOCAL_SERVICE_DIRECTORY_UNSAFE"))).toBe("WEB_START_FAILED (LOCAL_SERVICE_DIRECTORY_UNSAFE)");
  for(const [code,reason] of [["EACCES","PERMISSION_DENIED"],["EPERM","PERMISSION_DENIED"],["EEXIST","SERVICE_STATE_EXISTS"],["EADDRINUSE","ADDRESS_IN_USE"]])
    expect(webStartupDiagnostic(Object.assign(new Error("/private/user/config SECRET"),{code}))).toBe(`WEB_START_FAILED (${reason})`);
  for(const error of [new Error("WEB_PRIVATE_SECRET"),new Error("LOCAL_SERVICE_SECRET"),new Error("/sensitive/path token"),"SECRET",undefined])
    expect(webStartupDiagnostic(error)).toBe("WEB_START_FAILED");
  expect(webStartupDiagnostic(new Error("WEB_BROWSER_OPEN_FAILED"))).toBe("WEB_BROWSER_OPEN_FAILED");
});
