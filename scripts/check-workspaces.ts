import assert from 'node:assert/strict';
import {readFile, readdir, lstat} from 'node:fs/promises';
const json = async (name: string) => JSON.parse(await readFile(name, 'utf8'));
const root = await json('package.json'), core = await json('packages/core/package.json');
assert.deepEqual(root.workspaces, ['packages/core', 'packages/cli']);
assert.equal(core.version, root.version, 'The internal core package must match published runtime version');
assert.deepEqual(core.engines, root.engines);
assert.equal(core.private, true);
// Retired artifact-only folders may remain locally; package manifests define workspaces.
const packages = [];
for (const name of await readdir('packages')) {
 try { await readFile(`packages/${name}/package.json`); packages.push(name); }
 catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
}
assert.deepEqual(packages.sort(), ['cli', 'core']);
await assert.rejects(lstat('packages/desktop'), {code: 'ENOENT'}, 'Electron belongs to zhivex-app');
for (const alias of ['src', 'desktop']) {
 await assert.rejects(lstat(alias), {code: 'ENOENT'}, `${alias} compatibility alias must be removed`);
}
for (const directory of root.workspaces) {
 assert((await lstat(directory)).isDirectory(), `${directory} must be a physical package`);
}
const lock = await readFile('bun.lock','utf8');
for (const name of root.workspaces) assert(lock.includes(`"${name}":`), `${name} missing from root lockfile`);
assert(root.scripts.build.includes('--root ./packages/core/src'));
console.log('Core/CLI workspaces and runtime metadata verified; Electron is external.');
