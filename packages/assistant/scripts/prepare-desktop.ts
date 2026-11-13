import { writePilotManifest } from '../src/pilot/manifest.js';
/** Stage only built application files, production dependencies and the current Node runtime. */
import { cp, mkdir, rm, copyFile, chmod, readFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
if(process.platform!=='darwin'||process.arch!=='arm64')throw new Error('PILOT_PLATFORM_UNSUPPORTED: native pilot is validated only on macOS Apple Silicon.');
const root = fileURLToPath(new URL('../', import.meta.url));
const stage = path.join(root, 'src-tauri/runtime');
const run = (exe: string, args: string[], cwd = root) => execFileSync(exe, args, { cwd, stdio: 'inherit' });
const node = execFileSync('node', ['-p', 'process.execPath'], { encoding: 'utf8' }).trim();
run(node, ['-e', "const [major, minor] = process.versions.node.split('.').map(Number); if (major < 22 || (major === 22 && minor < 13)) process.exit(1)"]);
run('bun', ['run', 'build'], path.resolve(root, '../..'));
run('bun', ['run', 'build']);
await rm(stage, { recursive: true, force: true });
await mkdir(path.join(stage, 'web'), { recursive: true });
for (const name of ['package.json', 'bun.lock']) await copyFile(path.join(root, name), path.join(stage, name));
// Stage only declared entrypoints; stale developer diagnostics must never ship.
for(const entry of ['index.js','cli.js','desktop.js','preview/preview-server.js','pilot/cli.js']){
  await mkdir(path.dirname(path.join(stage,'dist',entry)),{recursive:true});
  await copyFile(path.join(root,'dist',entry),path.join(stage,'dist',entry));
}
await cp(path.join(root, 'web/dist'), path.join(stage, 'web/dist'), { recursive: true });
run('bun', ['install', '--production', '--frozen-lockfile', '--ignore-scripts'], stage);
// Reuse the exact built engine candidate, not a potentially older registry release.
const artifact = path.join(stage, 'harness.tgz');
run('bun', ['pm', 'pack', '--ignore-scripts', '--quiet', '--filename', artifact], path.resolve(root, '../..'));
const engine = path.join(stage, 'node_modules/@zhivex-ai/harness');
const installed = JSON.parse(await readFile(path.join(engine, 'package.json'), 'utf8'));
const candidate = JSON.parse(await readFile(path.resolve(root, '../../package.json'), 'utf8'));
for (const field of ['dependencies', 'optionalDependencies']) {
  if (JSON.stringify(installed[field]) !== JSON.stringify(candidate[field])) throw new Error('Engine dependency pins changed; update the Assistant registry pin before packaging.');
}
await rm(engine, { recursive: true, force: true });
await mkdir(engine, { recursive: true });
run('tar', ['-xzf', artifact, '-C', engine, '--strip-components=1']);
await rm(artifact);
await copyFile(node, path.join(stage, 'node'));
await chmod(path.join(stage, 'node'), 0o755);
// Tauri copies bin symlinks as files, which changes both identity and relative module resolution.
// Runtime entrypoints use explicit paths; dependency command shims are not part of the pilot.
await rm(path.join(stage,'node_modules','.bin'),{recursive:true,force:true});
await writePilotManifest(stage,execFileSync(node,['-p','process.versions.node'],{encoding:'utf8'}).trim());
console.log('Desktop runtime prepared for this operating system and architecture.');
