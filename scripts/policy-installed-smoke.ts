import { createHash } from 'node:crypto';
import { copyFile, mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

const artifact = process.argv[2];
const node = process.argv[3];
if (!artifact || !node) throw new Error('Pass an existing tarball and absolute Node executable.');
const root = await mkdtemp(path.join(tmpdir(), 'harness-policy-installed-'));
const bytes = await readFile(path.resolve(artifact));
const sha256 = createHash('sha256').update(bytes).digest('hex');
await copyFile(path.resolve(artifact), path.join(root, 'harness.tgz'));
await writeFile(path.join(root, 'package.json'), JSON.stringify({ private: true, type: 'module', dependencies: { '@zhivex-ai/harness': 'file:./harness.tgz' } }));
const run = async (args: string[], cwd: string) => {
  const child = Bun.spawn(args, { cwd, stdout: 'pipe', stderr: 'pipe', env: { PATH: process.env.PATH, HOME: root, TMPDIR: tmpdir() } });
  const timer = setTimeout(() => child.kill(), 60_000);
  try {
    const [stdout, stderr, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
    if (code !== 0) throw new Error(`Installed check failed (${code}): ${stdout}\n${stderr}`);
    return stdout.trim();
  } finally { clearTimeout(timer); }
};
await run([process.execPath, 'install', '--ignore-scripts'], root);
await copyFile(path.join(import.meta.dir, 'policy-installed-consumer.mjs'), path.join(root, 'consumer.mjs'));
const workspace = path.join(root, 'workspace');
await mkdir(workspace);
const phases = [];
for (const phase of ['prepare', 'incompatible', 'resume']) {
  phases.push(JSON.parse(await run([node, path.join(root, 'consumer.mjs'), phase], workspace)));
}
const report = { schemaVersion: 1, sha256, phases, installed: true, liveProvider: false, published: false, root };
await writeFile(path.join(root, 'report.json'), JSON.stringify(report, null, 2) + '\n');
console.log(JSON.stringify(report, null, 2));
