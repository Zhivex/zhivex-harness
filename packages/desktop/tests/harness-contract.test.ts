import {expect, test} from "bun:test";
import {mkdtemp, readdir, readFile, rm, writeFile} from "node:fs/promises";
import path from "node:path";
import {requiredHarnessExports, validateHarnessExports} from "../scripts/harness-contract.js";

test("candidate validation rejects a legacy package lacking unified application contracts", async () => {
  const root = await mkdtemp('/tmp/zhx-contract-');
  try {
    await writeFile(path.join(root, 'entry.js'), 'export {};');
    await writeFile(path.join(root, 'entry.d.ts'), 'export {};');
    const exports = Object.fromEntries(requiredHarnessExports.map(key => [key, {import: './entry.js', types: './entry.d.ts'}]));
    await validateHarnessExports(root, {exports});
    delete exports['./application/client'];
    await expect(validateHarnessExports(root, {exports})).rejects.toThrow('./application/client');
    exports['./application/client'] = {import: '../outside.js', types: './entry.d.ts'};
    await expect(validateHarnessExports(root, {exports})).rejects.toThrow('escapes its package');
  } finally {await rm(root, {recursive: true, force: true});}
});

test("every Harness import in application source is included in candidate admission", async () => {
  const root = path.resolve(import.meta.dir, '../src');
  const walk = async (directory: string): Promise<string[]> => {
    const entries = await readdir(directory, {withFileTypes: true});
    return (await Promise.all(entries.map(entry => entry.isDirectory() ? walk(path.join(directory, entry.name)) : [path.join(directory, entry.name)]))).flat();
  };
  for (const file of await walk(root)) {
    if (!/\.[cm]?[jt]sx?$/.test(file)) continue;
    const source = await readFile(file, 'utf8');
    for (const match of source.matchAll(/["']@zhivex-ai\/harness([^"']*)["']/g)) {
      expect(requiredHarnessExports as readonly string[]).toContain('.' + match[1]);
    }
  }
});
