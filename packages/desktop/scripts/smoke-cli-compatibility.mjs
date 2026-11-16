import {spawnSync} from 'node:child_process';
import {mkdir, readFile, writeFile} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
import path from 'node:path';
import assert from 'node:assert/strict';
const root=fileURLToPath(new URL('../../../',import.meta.url));
const installed=JSON.parse(await readFile(root+'/packages/desktop/.harness/installed.json','utf8'));
const core=path.join(installed.install,'node_modules/@zhivex-ai/harness');
const invoke=(entry,args)=>spawnSync('node',[entry,...args],{encoding:'utf8',timeout:15000,env:{PATH:process.env.PATH,ZHIVEX_HARNESS_CREDENTIAL_STORE:'disabled'}});
const versions=[];
for(const name of ['cli.js','zhx.js']) {const result=invoke(core+'/dist/'+name,['--version']);assert.equal(result.status,0);versions.push(result.stdout.trim());}
assert.deepEqual(versions,[installed.version,installed.version]);
for(const format of ['--json','--jsonl']) {const result=invoke(core+'/dist/zhx.js',['--web',format]);assert.equal(result.status,2);const body=JSON.parse(format==='--json'?result.stderr:result.stdout);assert.equal(body.error.code,'CLI_USAGE_INVALID');}
const web=invoke(core+'/dist/zhx.js',['--web']);assert.equal(web.status,2);assert.match(web.stderr,/Electron/);
const codeEntry=process.env.ZHIVEX_CODE_ENTRY;
assert.ok(codeEntry && path.isAbsolute(codeEntry), 'Set ZHIVEX_CODE_ENTRY to the absolute CLI entrypoint of an installed Code artifact.');
const legacy=invoke(codeEntry,['web','--help']);assert.equal(legacy.status,2,legacy.stderr);assert.match(legacy.stderr,/legacy browser.*removed/);
const report={passed:true,coreArtifactSha256:installed.sha256,checks:['zhx and zhivex-harness version aliases','web migration preserves JSON and JSONL error documents and exit 2','legacy web command is rejected with migration guidance'],keychainUsed:false};
await mkdir(root+'/results/unification',{recursive:true});
await writeFile(root+'/results/unification/entrypoints.json',JSON.stringify(report,null,2)+'\n');console.log(JSON.stringify(report,null,2));
