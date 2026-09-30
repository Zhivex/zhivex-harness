import { expect, test } from 'bun:test';
import { compileTaskAcceptanceContract } from '../src/runtime/task-acceptance.js';
import { validateTaskAcceptanceContract, validateTaskAcceptanceWorkspace } from '../src/runtime/task-acceptance-validation.js';
import { mkdtemp, mkdir, writeFile, symlink, link, rm } from 'node:fs/promises';
import { resolveHarnessConfig } from '../src/runtime/config.js';
import { z } from 'zod';

const fixture = () => ({ schemaVersion:1, taskId:'repair-parser', allowedWritePaths:['src/parser.ts','tests/parser.test.ts'], protectedFiles:['package.json'],
  requiredChecks:[{id:'test',kind:'package-script',script:'test',expectedScript:'bun test',command:'bun',args:['--no-env-file','run','test'],purpose:'Parser regression',execution:{backend:'none',approval:'required'}}],
  humanReview:[{id:'readability',requirement:'Operator reviews readability',status:'pending'}] });

test('requirements identity is canonical and detached, preserving exact argv', () => {
  const input=fixture(), original=compileTaskAcceptanceContract(input);
  const reordered=fixture(); reordered.allowedWritePaths.reverse();
  expect(compileTaskAcceptanceContract(reordered)).toEqual(original);
  input.requiredChecks[0]!.args.reverse();
  expect(compileTaskAcceptanceContract(input).digest).not.toBe(original.digest);
  expect(original.contract.requiredChecks[0]!.args).toEqual(['--no-env-file','run','test']);
  expect(original.contract.humanReview[0]?.status).toBe('pending');
});

for (const filename of ['../escape','/absolute','C:\\private','src\\file.ts','src/*.ts','src/./file.ts','src/file\n.ts']) {
  test(`rejects unsafe or nonexact acceptance path ${JSON.stringify(filename)}`, () => {
    const input=fixture(); input.allowedWritePaths=[filename];
    expect(()=>compileTaskAcceptanceContract(input)).toThrow('TASK_ACCEPTANCE_INVALID');
  });
}
test('rejects conflicting exact files and duplicate criteria', () => {
  const input=fixture(); input.protectedFiles=['SRC/parser.ts'];
  expect(()=>compileTaskAcceptanceContract(input)).toThrow('conflict');
  input.protectedFiles=[]; input.allowedWritePaths=['src','src/parser.ts'];
  expect(()=>compileTaskAcceptanceContract(input)).toThrow('ancestor');
  input.allowedWritePaths=[]; input.requiredChecks.push({...input.requiredChecks[0]!});
  expect(()=>compileTaskAcceptanceContract(input)).toThrow('Duplicate');
});
test('rejects empty checks, subjective pass claims and shell commands', () => {
  const input=fixture(); input.requiredChecks=[];
  expect(()=>compileTaskAcceptanceContract(input)).toThrow('requiredChecks');
  const subjective=fixture(); subjective.humanReview[0]!.status='passed';
  expect(()=>compileTaskAcceptanceContract(subjective)).toThrow('humanReview');
  const shell=fixture(); shell.requiredChecks[0]!.command='sh'; shell.requiredChecks[0]!.args=['-c','echo passed'];
  expect(()=>compileTaskAcceptanceContract(shell)).toThrow('Shell');
});
test('rejects unknown fields, blank scripts, non-OCI argv and oversized contracts', () => {
  expect(()=>compileTaskAcceptanceContract({...fixture(),approved:true})).toThrow('TASK_ACCEPTANCE_INVALID');
  const input=fixture(); input.requiredChecks[0]!.expectedScript=' ';
  expect(()=>compileTaskAcceptanceContract(input)).toThrow('nonblank');
  expect(()=>compileTaskAcceptanceContract({...fixture(),requiredChecks:[{id:'node',kind:'argv',command:'node',args:['--test'],purpose:'Test',execution:{backend:'none',approval:'required',network:'none'}}]})).toThrow('TASK_ACCEPTANCE_INVALID');
  expect(()=>compileTaskAcceptanceContract({...fixture(),oversized:'x'.repeat(65536)})).toThrow('TOO_LARGE');
});

test('host preflight binds exact declared script argv without executing it', async () => {
  let executed=0;
  const host={config:resolveHarnessConfig({workspace:process.cwd(),allowedChecks:['test']}),
    tools:{run_check:{name:'run_check',description:'fixture',schema:z.object({}),execute:async()=>{executed++;return 'unexpected';}}},
    packageManifest:{packageManager:'bun@1.4.0',scripts:{test:'bun test'}}};
  expect(await validateTaskAcceptanceContract(fixture(),host)).toEqual(compileTaskAcceptanceContract(fixture()));
  const unknown=fixture(); unknown.requiredChecks[0]!.script='unknown';
  await expect(validateTaskAcceptanceContract(unknown,host)).rejects.toThrow('allowlist');
  const changed=fixture(); changed.requiredChecks[0]!.expectedScript='bun test other';
  await expect(validateTaskAcceptanceContract(changed,host)).rejects.toThrow('changed');
  const argv=fixture(); argv.requiredChecks[0]!.args=['run','test'];
  await expect(validateTaskAcceptanceContract(argv,host)).rejects.toThrow('command/arguments');
  await expect(validateTaskAcceptanceContract(fixture(),{...host,tools:{}})).rejects.toThrow('unavailable');
  await expect(validateTaskAcceptanceContract(fixture(),{...host,policy:{schemaVersion:1,rules:[{id:'deny-checks',tools:['run_check'],decision:'deny',reason:'No checks'}]}})).rejects.toThrow('policy denies');
  expect(executed).toBe(0);
});

test('host preflight rejects backend mismatch and non-allowlisted OCI commands', async () => {
  const input={...fixture(),requiredChecks:[{id:'test',kind:'argv',command:'node',args:['--test'],purpose:'Test',execution:{backend:'oci',approval:'required',network:'none'}}]};
  const tools={run_environment_command:{name:'run_environment_command',description:'fixture',schema:z.object({}),execute:async()=>{throw new Error('Must not execute');}}};
  await expect(validateTaskAcceptanceContract(input,{config:resolveHarnessConfig({workspace:process.cwd()}),tools})).rejects.toThrow('backend');
  const config=resolveHarnessConfig({workspace:process.cwd(),executionBackend:'oci',ociAllowedCommands:['bun']});
  await expect(validateTaskAcceptanceContract(input,{config,tools})).rejects.toThrow('allowlist');
  const permitted=resolveHarnessConfig({workspace:process.cwd(),executionBackend:'oci',ociAllowedCommands:['bun','node']});
  expect((await validateTaskAcceptanceContract(input,{config:permitted,tools})).contract.requiredChecks[0]?.command).toBe('node');
});

test('workspace preflight rejects protected paths, links, nonfiles and unsafe manifests without writes', async () => {
  const root=await mkdtemp('/tmp/har-task-contract-');
  const host={config:resolveHarnessConfig({workspace:root,allowedChecks:['test']}),tools:{run_check:{name:'run_check',description:'fixture',schema:z.object({}),execute:async()=>{throw new Error('Must not run');}}}};
  try {
    await writeFile(root+'/package.json',JSON.stringify({packageManager:'bun@1.4.0',scripts:{test:'bun test'}}));
    await mkdir(root+'/src'); await writeFile(root+'/src/parser.ts','original');
    expect((await validateTaskAcceptanceWorkspace(fixture(),host)).digest).toMatch(/^sha256:/);
    for(const filename of ['.env','node_modules/x.ts','.git/config']) {
      await expect(validateTaskAcceptanceWorkspace({...fixture(),allowedWritePaths:[filename]},host)).rejects.toThrow('PATH_DENIED');
    }
    await symlink(root+'/src',root+'/alias');
    await expect(validateTaskAcceptanceWorkspace({...fixture(),allowedWritePaths:['alias/new.ts']},host)).rejects.toThrow('PATH_DENIED');
    await expect(validateTaskAcceptanceWorkspace({...fixture(),allowedWritePaths:['src']},host)).rejects.toThrow('PATH_DENIED');
    await link(root+'/src/parser.ts',root+'/linked.ts');
    await expect(validateTaskAcceptanceWorkspace({...fixture(),allowedWritePaths:['linked.ts']},host)).rejects.toThrow('PATH_DENIED');
    await rm(root+'/linked.ts');
    await rm(root+'/package.json'); await symlink(root+'/src/parser.ts',root+'/package.json');
    await expect(validateTaskAcceptanceWorkspace(fixture(),host)).rejects.toThrow('MANIFEST_INVALID');
    expect(await Bun.file(root+'/src/parser.ts').text()).toBe('original');
  } finally { await rm(root,{recursive:true,force:true}); }
});
