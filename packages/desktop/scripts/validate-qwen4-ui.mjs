import {_electron as electron} from 'playwright';
import {mkdtemp,realpath,mkdir,writeFile,readFile} from 'node:fs/promises';
import {execFileSync} from 'node:child_process';
import {randomUUID,createHash} from 'node:crypto';
import {AsyncEntry} from '@napi-rs/keyring';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import assert from 'node:assert/strict';
import {once} from 'node:events';
if(process.env.ZHIVEX_HARNESS_LIVE!=='1')throw new Error('Live opt-in required');
const packaged=process.argv.includes('--packaged');
const approval=process.argv.includes('--approval');
const root=fileURLToPath(new URL('../../../',import.meta.url));
const directory=await realpath(await mkdtemp('/tmp/zhx-qwen4-ui-'));
const workspace=path.join(directory,'repo');await mkdir(workspace);
execFileSync('git',['-C',workspace,'init','-q']);
const receipt='ELECTRON_RECEIPT_'+randomUUID();
await writeFile(path.join(workspace,'receipt.txt'),receipt+'\n');
const key=process.env.DASHSCOPE_API_KEY||process.env.QWEN_API_KEY;
assert(key);
let desktop,page;
const report={model:'qwen4-max',packaged,approval,directory,ok:false,checks:[]};
try {
 desktop=await electron.launch({executablePath:path.join(root,packaged?'packages/desktop/out/Zhivex Harness-darwin-arm64/Zhivex Harness.app/Contents/MacOS/Zhivex Harness':'packages/desktop/node_modules/electron/dist/Electron.app/Contents/MacOS/Electron'),args:[...(packaged?[]:[path.join(root,'packages/desktop')]),'--assistant-directory',directory,'--user-data',path.join(directory,'electron')],env:{PATH:process.env.PATH,HOME:process.env.HOME},timeout:45000});
 page=await desktop.firstWindow();page.setDefaultTimeout(60000);
 await page.getByLabel('Assistant name',{exact:true}).fill('Qwen4 UI validation');
 await page.getByRole('button',{name:'Create assistant',exact:true}).click();
 await page.getByLabel('Provider',{exact:true}).selectOption('qwen');
 await page.getByLabel('Model',{exact:true}).fill('qwen4-max');
 await page.getByLabel('API key',{exact:true}).fill(key);
 await page.getByRole('button',{name:'Connect and start',exact:true}).click();
 await page.getByRole('heading',{name:'Your model is connected.',exact:true}).waitFor();
 report.checks.push('Qwen provider and qwen4-max selected and connected through onboarding');
 console.log('Onboarding passed');
 await page.getByRole('button',{name:'Code',exact:true}).click();
 await page.getByRole('button',{name:'Choose project folder',exact:true}).waitFor();
 assert.match(await page.getByLabel(/^Model connection/).innerText(),/qwen4-max/);
 await desktop.evaluate(({dialog},folder)=>{dialog.showOpenDialog=async()=>({canceled:false,filePaths:[folder]});},workspace);
 await page.getByRole('button',{name:'Choose project folder',exact:true}).click();
 await page.getByRole('button',{name:/^New conversation/}).first().click();
 await page.getByRole('button',{name:'Rename conversation',exact:true}).waitFor();
 await page.getByText('Start with an idea.',{exact:true}).waitFor();
 await page.getByLabel('Message',{exact:true}).fill(approval ? 'Read receipt.txt using read_file, then use apply_reviewed_replacement to replace its contents with exactly APPROVED_QWEN4_WRITE followed by one newline. Use the digest from the read. Request approval for the edit. After approval, verify the saved file with read_file and report success in 12 short numbered sentences.' : 'Read receipt.txt with the file reading tool. Do not modify files. Print the exact receipt, then write 12 numbered short sentences explaining why verifying actual tool results matters.');
 await page.evaluate(()=>{
  window.liveSamples=[];
  const collect=()=>{
   const a=document.querySelector('.assistant-message'); if(!a)return;
   const text=[...a.querySelectorAll('p,li')].filter(e=>!e.closest('.tool-activity')&&!e.classList.contains('status')).map(e=>e.textContent).join('\n');
   const status=a.querySelector('.status')?.textContent;
   if(text && !window.liveSamples.some(x=>x.text===text))window.liveSamples.push({text,status,time:Date.now()});
  };
  window.liveObserver=new MutationObserver(collect);window.liveObserver.observe(document.body,{childList:true,subtree:true,characterData:true});
 });
 await page.getByRole('button',{name:'Send message',exact:true}).click();
 if(approval){
  await page.getByText('An action needs your review.',{exact:true}).waitFor({timeout:180000});
  assert.equal(await readFile(path.join(workspace,'receipt.txt'),'utf8'),receipt+'\n');
  report.unchangedBeforeApproval=true;
  await page.getByRole('button',{name:'Review action',exact:true}).click();
  const loadReview=page.getByRole('button',{name:'Load review',exact:true});
  if(await loadReview.count())await loadReview.click();
  await page.getByRole('checkbox',{name:'Viewed',exact:true}).waitFor();
  assert(await page.getByRole('button',{name:'Approve this action',exact:true}).isDisabled());
  await page.getByRole('checkbox',{name:'Viewed',exact:true}).check();
  assert.equal(await readFile(path.join(workspace,'receipt.txt'),'utf8'),receipt+'\n');
  await page.screenshot({path:path.join(directory,'electron-approval.png')});
  await page.getByRole('button',{name:'Approve this action',exact:true}).click();
  console.log('Explicit UI approval submitted');
  await page.getByRole('button',{name:'Workspace',exact:true}).click();
 }
 await page.getByText('Response complete',{exact:true}).waitFor({timeout:180000});
 const rendered=await page.locator('.assistant-message').innerText();
 if(approval){
  assert.equal(await readFile(path.join(workspace,'receipt.txt'),'utf8'),'APPROVED_QWEN4_WRITE\n');
  report.writtenAfterApproval=true;
 } else assert(rendered.includes(receipt),'Receipt must be read from the actual file');
 const tools=await page.locator('[data-tool]').evaluateAll(es=>es.map(e=>({name:e.dataset.tool,status:e.dataset.toolStatus})));
 assert(tools.some(t=>t.name==='read_file'||t.name==='read_files'),'No file reading tool shown');
 if(approval)assert(tools.some(t=>t.name==='apply_reviewed_replacement'&&t.status==='completed'),'Write tool did not complete');
 const samples=await page.evaluate(()=>{window.liveObserver.disconnect();return window.liveSamples;});
 const partial=samples.filter(s=>s.status==='Responding…');
 assert(partial.length>=2,'Expected multiple partial rendered responses');
 assert(await page.getByText('qwen4-max',{exact:true}).count()>0,'Turn model missing');
 await page.screenshot({path:path.join(directory,'electron-completed.png')});
 if(approval)report.checks.push('File unchanged before approval; Viewed gate enforced; exact file content applied after explicit approval');
 report.checks.push('Qwen4 model connection selected for Code project','File tool displayed and exact local receipt returned','Multiple partial responses rendered before Response complete');
 Object.assign(report,{ok:true,tools,partialRenderCount:partial.length,finalText:rendered,screenshot:path.join(directory,'electron-completed.png')});
 console.log('Approval and streaming assertions passed');
} catch(e) {
 report.error=String(e.message).replaceAll(key,'[REDACTED]');
 if(page){report.visibleText=(await page.locator('body').innerText().catch(()=>'' )).replaceAll(key,'[REDACTED]');await page.screenshot({path:path.join(directory,'failure.png')}).catch(()=>{});}
 console.log(JSON.stringify({ok:false,error:report.error,visibleText:report.visibleText}));process.exitCode=1;
} finally {
 if(desktop){
  try {
   // Exercise the real quit handler; automate only the native dialog answer.
   await desktop.evaluate(({Menu,dialog})=>{
    globalThis.qwenQuitPrompt=null;
    dialog.showMessageBox=async options=>{globalThis.qwenQuitPrompt=options;return {response:0,checkboxChecked:false};};
    Menu.getApplicationMenu().getMenuItemById('quit-zhivex').click();
   });
   const deadline=Date.now()+10000;
   let prompt;
   while(!(prompt=await desktop.evaluate(()=>globalThis.qwenQuitPrompt))){
    if(Date.now()>deadline)throw new Error('QUIT_PROMPT_TIMEOUT');
    await new Promise(resolve=>setTimeout(resolve,50));
   }
   assert.deepEqual(prompt.buttons,['Keep running','Stop service and quit']);
   assert.equal(prompt.cancelId,0);
   assert.match(prompt.detail,/0 unfinished tasks/);
   assert.equal(desktop.process().exitCode,null);
   report.quitCancellationPreservedApp=true;
   await desktop.evaluate(({dialog})=>{
    dialog.showMessageBox=async options=>{
     if(options.message!=='Stop the service and quit?')throw new Error('UNEXPECTED_SHUTDOWN_DIALOG');
     return {response:1,checkboxChecked:false};
    };
    dialog.showErrorBox=title=>{throw new Error(title);};
   });
   const started=Date.now();
   const exited=once(desktop.process(),'exit');
   let timer;
   try {
    const [code,signal]=await Promise.race([
     Promise.all([desktop.close(),exited]).then(([,exit])=>exit),
     new Promise((_,reject)=>{timer=setTimeout(()=>reject(new Error('GRACEFUL_SHUTDOWN_TIMEOUT')),30000);})
    ]);
    assert.equal(code,0);assert.equal(signal,null);
    report.shutdown={confirmed:true,exitCode:code,signal,forced:false,durationMs:Date.now()-started};
    report.checks.push('Quit cancellation preserves app; confirmed shutdown exits normally without forced termination');
   } finally {clearTimeout(timer);}
  } catch(error) {
   report.ok=false;report.shutdownError=String(error.message).replaceAll(key,'[REDACTED]');process.exitCode=1;
  }
 }
 await new AsyncEntry('ai.zhivex.assistant',createHash('sha256').update(directory).digest('hex')).deleteCredential().catch(()=>{});
 console.log(JSON.stringify({ok:report.ok,shutdown:report.shutdown,shutdownError:report.shutdownError,partialRenderCount:report.partialRenderCount}));
 await writeFile(path.join(root,`docs/reports/evidence/qwen4-max-electron${packaged?'-packaged':''}${approval?'-approval':''}-ui-2026-11-16.json`),JSON.stringify(report,null,2)+'\n');
}
