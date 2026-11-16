// Electron's own Node/SQLite runtime, no external Node/Bun executable and no native credentials.
import {spawn} from 'node:child_process';
import {mkdtemp, readFile, writeFile} from 'node:fs/promises';
import {pathToFileURL, fileURLToPath} from 'node:url';
import path from 'node:path';
import assert from 'node:assert/strict';
const root=fileURLToPath(new URL('../../../',import.meta.url)), directory=await mkdtemp('/tmp/zhx-bundled-core-');
const installed=JSON.parse(await readFile(root+'/packages/desktop/.harness/installed.json','utf8'));
const entry=pathToFileURL(path.join(installed.install,'node_modules/@zhivex-ai/harness/dist/engine/application.js')).href;
const client=pathToFileURL(path.join(installed.install,'node_modules/@zhivex-ai/harness/dist/engine/application-client.js')).href;
await writeFile(directory+'/config.json',JSON.stringify({entry,client,app:directory+'/app',result:directory+'/runtime.json'}));
await writeFile(directory+'/worker.cjs',`(async()=>{
 const {readFile,writeFile}=require('node:fs/promises');
 const path=require('node:path');
 const config=JSON.parse(await readFile(path.join(__dirname,'config.json'),'utf8'));
 const {startApplicationCoordinator}=await import(config.entry);
 const {connectCoordinator}=await import(config.client);
 let stored=null;
 const owner=await startApplicationCoordinator(config.app,{secrets:{async read(){return stored},async write(value){stored=value}},validateProvider:async()=>{}});
 try {const c=await connectCoordinator(config.app);
 await c.call('action',{name:'begin',value:{name:'Bundled fixture'}});
 await c.call('action',{name:'provider',value:{baseURL:'https://example.invalid/v1',model:'offline',apiKey:'synthetic-no-network'}});
 await c.call('action',{name:'start',value:{}});
 const state=await c.catalog();
 if(state.runtimes.length!==1) throw new Error('HOST_NOT_READY');
 await writeFile(config.result,JSON.stringify({passed:true,electron:process.versions.electron,node:process.versions.node,path:process.env.PATH,agents:state.agents.length,sqliteHostReady:true}));
 }finally{await owner.close()}
 process.exit(0);
})().catch(e=>{console.error(e);process.exit(1)});`);
await writeFile(directory+'/main.cjs',`const {app,utilityProcess}=require('electron');app.whenReady().then(()=>{const c=utilityProcess.fork(require('node:path').join(__dirname,'worker.cjs'),[],{stdio:'pipe'});c.stderr.on('data',x=>process.stderr.write(x));c.on('exit',code=>app.exit(code));});`);
const child=spawn(root+'/packages/desktop/node_modules/electron/dist/Electron.app/Contents/MacOS/Electron',[directory+'/main.cjs','--user-data-dir='+directory+'/electron'],{env:{PATH:'/usr/bin:/bin',HOME:directory,ZHIVEX_HARNESS_CREDENTIAL_STORE:'disabled'},stdio:['ignore','ignore','pipe']});
let errors='';child.stderr.on('data',x=>errors+=x);
const timer=setTimeout(()=>child.kill('SIGKILL'),30000);
try {const code=await new Promise((resolve,reject)=>{child.on('error',reject);child.on('exit',resolve)});assert.equal(code,0,errors);const runtime=JSON.parse(await readFile(directory+'/runtime.json','utf8'));assert(runtime.electron);const report={...runtime,coreArtifactSha256:installed.sha256,limitations:['Injected in-memory SecretStore; unsigned development Electron runtime, not distribution certification']};await writeFile(directory+'/report.json',JSON.stringify(report,null,2));console.log(JSON.stringify({directory,...report},null,2));}finally{clearTimeout(timer);}
