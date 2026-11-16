import {readdir, readFile} from 'node:fs/promises';
import path from 'node:path';
import {sourceDependencies} from './source-dependencies.js';
import {installedHarness} from './installed-harness.js';

const root = path.resolve(import.meta.dir, '..');
const {metadata} = await installedHarness(root);
const failures: string[] = [];
const browserContracts = new Set(['@zhivex-ai/harness/models', '@zhivex-ai/harness/protocol', '@zhivex-ai/harness/application/protocol']);
async function visit(directory: string) {
  for (const entry of await readdir(directory, {withFileTypes: true})) {
    const file = path.join(directory, entry.name);
    if (entry.isDirectory()) {await visit(file); continue;}
    if (!/\.[cm]?[jt]sx?$/.test(file)) continue;
    const relative = path.relative(root, file);
    for (const dependency of sourceDependencies(await readFile(file, 'utf8'))) {
      const target = dependency.target;
      if (dependency.computed) failures.push(`${relative}: computed module imports cannot prove independence`);
      if (target.startsWith('.') && !path.resolve(path.dirname(file), target).startsWith(root + path.sep)) failures.push(`${relative}: source import escapes Desktop: ${target}`);
      if (/^@zhivex-ai\/code(?:\/|$)/.test(target)) failures.push(`${relative}: use an explicit CLI artifact for cross-client tests`);
      if (/^@zhivex-ai\/harness(?:\/|$)/.test(target)) {
        const subpath = '.' + target.slice('@zhivex-ai/harness'.length);
        if (subpath === '.' || !metadata.exports?.[subpath]) failures.push(`${relative}: undeclared or broad Harness import: ${target}`);
        if ((relative.endsWith('.tsx') || relative === 'src/unified/bridge.ts') && relative.startsWith('src/') && !browserContracts.has(target) && !(dependency.typeOnly && target === '@zhivex-ai/harness/application')) failures.push(`${relative}: renderer contract must be browser-safe: ${target}`);
      }
      if (relative.startsWith('src/') && target.startsWith('.') && /^(?:testing|tests|scripts)\//.test(path.relative(root, path.resolve(path.dirname(file), target)))) failures.push(`${relative}: production source cannot import test/build helpers`);
    }
  }
}
for (const directory of ['src', 'scripts', 'tests', 'testing']) await visit(path.join(root, directory));
if (failures.length) throw new Error(failures.join('\n'));
console.log('Desktop imports stay inside its workspace or declared Harness package exports.');
