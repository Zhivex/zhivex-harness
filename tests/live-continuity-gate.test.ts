import { expect, test } from 'bun:test';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createContinuityEvidence, continuityGateOutcome } from '../scripts/live-continuity-contract.js';

test('continuity JSON reaches the release wrapper with provider, phase and failed checks', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'harness-continuity-gate-'));
  try {
    const out = path.join(root, 'continuity.json');
    const evidence = createContinuityEvidence().snapshot({outputText:'PRIVATE_MODEL_TEXT',usage:{inputTokens:1679,outputTokens:830,reasoningTokens:790}});
    const envelope = { ok: false, providers: [
      continuityGateOutcome({provider:'meta',status:'passed'}),
      continuityGateOutcome({provider:'qwen',status:'failed',phases:[
        {phase:2,status:'failed',checks:{codename:false,objective:true},message:'PRIVATE_MODEL_TEXT',evidence}
      ]})
    ] };
    const child = Bun.spawn([process.execPath, 'run', 'scripts/run-release-gate.ts', '--gate', 'continuity', '--out', out,
      '--', process.execPath, '-e', `process.stdout.write(${JSON.stringify(JSON.stringify(envelope))}); process.stderr.write('PRIVATE_STDERR'); process.exitCode=1;`], {
      cwd: path.resolve(import.meta.dir, '..'), env: { ...process.env,
        RELEASE_TAG:'v1.3.0-rc.5', SOURCE_COMMIT:'a'.repeat(40), ARTIFACT_SHA512:`sha512-${Buffer.alloc(64).toString('base64')}`,
        WORKFLOW_RUN_URL:'https://github.com/Zhivex/zhivex-harness/actions/runs/36790074025', WORKFLOW_RUN_ATTEMPT:'2'
      }, stdout:'pipe', stderr:'pipe'
    });
    const [code, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
    expect(code).toBe(1);
    const persisted = await readFile(out, 'utf8');
    const diagnostic = JSON.parse(persisted);
    expect(diagnostic.status).toBe('failed');
    expect(diagnostic.outcomes[0]).toEqual({provider:'meta',status:'passed'});
    expect(diagnostic.outcomes[1]).toMatchObject({provider:'qwen',status:'failed'});
    expect(diagnostic.outcomes[1].error.details.chain[0]).toEqual({checkpoint:'continuity_phase',continuity:{phase:2,failedChecks:['codename'],evidence}});
    expect(`${stdout}${stderr}${persisted}`).not.toContain('PRIVATE_');
  } finally { await rm(root, {recursive:true,force:true}); }
});
