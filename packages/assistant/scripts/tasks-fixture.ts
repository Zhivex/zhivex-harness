/** Offline stage-5 host. Only temporary repositories and local commits are used. */
import {mkdtemp,mkdir,writeFile,rm} from 'node:fs/promises';
import {execFileSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {createMockLanguageModel} from '@zhivex-ai/core/testing';
import {startAssistantHost} from '../src/host.js';
import {startAssistantWeb} from '../src/web/server.js';
import {nativeProjectSelection} from '../src/native-selection.js';
import {createDesktopLifecycle} from '../src/desktop-lifecycle.js';
export async function tasksFixture(native=false){
 const root=await mkdtemp('/tmp/task-delivery-smoke-'),repo=root+'/sample-project';await mkdir(repo);
 const git=(args:string[])=>execFileSync('git',['-C',repo,...args],{encoding:'utf8'}).trim();git(['init','-q','-b','main']);git(['config','user.name','Fixture']);git(['config','user.email','fixture@example.invalid']);await writeFile(repo+'/note.txt','base\n');git(['add','.']);git(['commit','-qm','baseline']);await writeFile(repo+'/note.txt','source dirty\n');
 const host=await startAssistantHost({directory:root+'/state',ownerId:'task-fixture',engine:{modelInstance:createMockLanguageModel({streamEvents:[]}),model:'offline-task-fixture'},coding:{execution:'local',configurationId:'task-fixture-v1'}});
 const app=host.application!,registered=await app.client.registerProject(await app.selectProject(repo));if(!registered.ok)throw Error(registered.error.code);
 const bridge=native?nativeProjectSelection(process.stdin,process.stdout,()=>void close().then(()=>process.exit(0)),()=>lifecycle.requestQuit()):{async request(){return {};}};
 const lifecycle=await createDesktopLifecycle({directory:root,native:bridge,control:op=>host.controlClose(op),work:()=>app.work(),close:async()=>{await close();if(native)process.exit(0);}});
 const web=await startAssistantWeb(host,{assetsDirectory:fileURLToPath(new URL('../web/dist',import.meta.url)),lifecycle,...(native?{native:bridge,chooseProject:()=>('choose' in bridge?bridge.choose():Promise.resolve(null))}:{chooseProject:async()=>repo})});
 async function close(){lifecycle.stop();await web.close();await host.close();if(!native)await rm(root,{recursive:true,force:true});}
 return{...web,app,root,repo,projectKey:registered.data.projectKey,close};
}
if(process.argv.includes('--native-tasks')){const f=await tasksFixture(true);await writeFile('/tmp/tauri-stage5/native-fixture.json',JSON.stringify({url:f.url,root:f.root,repo:f.repo,projectKey:f.projectKey}),{mode:0o600});process.stdout.write(JSON.stringify({url:f.url})+'\n');process.stdin.resume();}
