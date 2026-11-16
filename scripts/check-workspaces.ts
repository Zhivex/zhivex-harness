import assert from 'node:assert/strict';
import {readFile, readdir, lstat} from 'node:fs/promises';
const json = async (name: string) => JSON.parse(await readFile(name, 'utf8'));
const root = await json('package.json'), core = await json('packages/core/package.json');
assert.deepEqual(root.workspaces, ['packages/core', 'packages/cli', 'packages/desktop']);
assert.equal(core.version, root.version, 'The internal core package must match published runtime version');
assert.deepEqual(core.engines, root.engines);
assert.equal(core.private, true);
assert.deepEqual((await readdir('packages')).sort(), ['cli', 'core', 'desktop']);
for (const alias of ['src', 'desktop']) {
 await assert.rejects(lstat(alias), {code: 'ENOENT'}, `${alias} compatibility alias must be removed`);
}
for (const directory of root.workspaces) {
 assert((await lstat(directory)).isDirectory(), `${directory} must be a physical package`);
}
const lock = await readFile('bun.lock','utf8');
for (const name of root.workspaces) assert(lock.includes(`"${name}":`), `${name} missing from root lockfile`);
assert(root.scripts.build.includes('--root ./packages/core/src'));
const trust = await json('packages/desktop/update-trust.json');
assert.equal(trust.enabled, false, 'Phase 7 production feed remains disabled pending signed distribution certification');
console.log('Canonical workspaces, runtime metadata and disabled distribution gate verified.');
