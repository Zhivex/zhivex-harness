import { spawn, execFileSync } from 'node:child_process';
import { mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';
const root = path.resolve(import.meta.dir, '..'), packaged = process.argv.includes('--packaged');
const interruptedFork = process.argv.includes('--interrupted-fork');
const output = await mkdtemp('/tmp/har-checkpoints-'), workspace = path.join(output, 'repo'), report = path.join(output, 'report');
await mkdir(workspace); await mkdir(report);
execFileSync('git', ['init', '-q', workspace], { env: { PATH: process.env.PATH!, HOME: output } });
await writeFile(path.join(workspace, 'review.txt'), 'checkpoint original\n');
const executable = packaged ? path.join(root, 'out/Zhivex Harness-darwin-arm64/Zhivex Harness.app/Contents/MacOS/Zhivex Harness') : path.join(root, 'node_modules/electron/dist/Electron.app/Contents/MacOS/Electron');
const phases = [];
for (const phase of interruptedFork ? ['prepare', 'recover', 'apply', 'history'] : ['prepare', 'apply', 'history']) {
  const child = spawn(executable, [...(packaged ? [] : [root]), ...(phase === 'prepare' ? ['--workspace', workspace] : []),
    '--smoke-test', '--fixture-checkpoints', phase, ...(interruptedFork ? ['--fixture-checkpoint-interrupted'] : []), '--report-directory', report], { cwd: output, env: { PATH: process.env.PATH!, HOME: output }, stdio: ['ignore', 'pipe', 'pipe'] });
  let stderr = ''; child.stderr.on('data', chunk => { stderr += chunk; }); child.stdout.resume();
  const timer = setTimeout(() => child.kill('SIGKILL'), 60000);
  try {
    const code = await new Promise<number | null>((resolve, reject) => { child.once('exit', resolve); child.once('error', reject); });
    assert.equal(code, 0, `${phase}: ${report}\n${stderr}`);
    const result = JSON.parse(await readFile(path.join(report, `${phase}-report.json`), 'utf8'));
    assert.equal(result.status, 'passed'); assert.equal(result.packaged, packaged);
    for (const pid of [result.appPid, result.runtimePid]) assert.throws(() => process.kill(pid, 0), (error: unknown) => (error as NodeJS.ErrnoException).code === 'ESRCH');
    phases.push(result);
  } finally { clearTimeout(timer); if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL'); }
}
assert.equal(new Set(phases.map(phase => phase.appPid)).size, phases.length);
assert.equal(new Set(phases.map(phase => phase.runtimePid)).size, phases.length);
assert.equal(new Set(phases.map(phase => phase.source)).size, 1);
const evidence = { status: 'passed', packaged, fixture: true, interruptedFork, wholeAppRestart: true, explicitReview: true, oldTicketRejected: true,
  originalPreserved: true, derivativeOpened: true, singleDerivative: true, workersExited: true, phases, evidenceDirectory: report };
await writeFile(path.join(report, 'report.json'), JSON.stringify(evidence, null, 2)); console.log(JSON.stringify(evidence));
