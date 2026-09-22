import { expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

const fixture = path.resolve(import.meta.dir, "fixtures/first-use-fetch.mjs");
const request = `await fetch('https://api.openai.com/v1/responses', { headers: { authorization: 'Bearer first-use-fixture-only' } });`;
function invoke(counter: string, setup = "") {
  return spawnSync("node", ["--input-type=module", "-e", `${setup}\nawait import(${JSON.stringify(fixture)});\n${request}`], {
    env: { PATH: process.env.PATH!, FIRST_USE_COUNTER: counter }, encoding: "utf8"
  });
}

test("counter is created and persists across fixture processes", () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "fixture-counter-"));
  try {
    const counter = path.join(root, "calls");
    for (let n = 1; n <= 5; n++) {
      const result = invoke(counter);
      expect(result.stderr).toBe("");
      expect(result.status).toBe(0);
      expect(readFileSync(counter, "utf8")).toBe(String(n));
    }
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("counter symlinks cannot overwrite a target", () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "fixture-counter-"));
  try {
    const target = path.join(root, "target");
    const counter = path.join(root, "calls");
    writeFileSync(target, "protected");
    symlinkSync(target, counter);
    expect(invoke(counter).status).not.toBe(0);
    expect(readFileSync(target, "utf8")).toBe("protected");
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("replacing the counter path after opening cannot redirect the write", () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "fixture-counter-"));
  try {
    const counter = path.join(root, "calls");
    writeFileSync(counter, "0");
    writeFileSync(`${counter}.target`, "protected");
    const result = invoke(counter, `
      import fs from 'node:fs';
      import { syncBuiltinESMExports } from 'node:module';
      const read = fs.readFileSync;
      fs.readFileSync = function(fd, ...args) {
        if (typeof fd !== 'number') return read(fd, ...args);
        const counter = process.env.FIRST_USE_COUNTER;
        fs.renameSync(counter, counter + '.opened');
        fs.symlinkSync(counter + '.target', counter);
        return read(fd, ...args);
      };
      syncBuiltinESMExports();
    `);
    expect(result.stderr).toBe("");
    expect(result.status).toBe(0);
    expect(readFileSync(`${counter}.target`, "utf8")).toBe("protected");
    expect(readFileSync(`${counter}.opened`, "utf8")).toBe("1");
  } finally { rmSync(root, { recursive: true, force: true }); }
});
