import { sourceRevision } from './revision.js';
import { createHash, randomUUID } from 'node:crypto';
import { fork, type ChildProcess } from 'node:child_process';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { readdir, open, rename, unlink } from 'node:fs/promises';
import { ensureProjectPrivateDirectory } from '../projects.js';
import { syncPrivateDirectory } from '../private-directory.js';
import path from 'node:path';
import { chromium, type Browser } from 'playwright';
import { z } from 'zod';
import { normalizeHarnessMcpConfiguration, type CreateCodingHarnessOptions } from '@zhivex-ai/harness/engine';
import { readRegularFileNoFollow } from '../delivery/file-security.js';

const hash = (bytes: string | Buffer) => createHash('sha256').update(bytes).digest('hex');
const relative = z.string().max(256).refine(s => !s.includes('\\') && !s.includes('\0') && !path.isAbsolute(s) && s.split('/').every(p => p && p !== '..' && !p.startsWith('.')), 'Use a relative directory without hidden segments');
const planSchema = z.object({ path: z.string().max(512).regex(/^\/(?!\/)[^\\#]*$/), steps: z.array(z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('text'), selector: z.string().min(1).max(256), text: z.string().min(1).max(1000) }).strict(),
  z.object({ kind: z.literal('click'), selector: z.string().min(1).max(256) }).strict(),
])).min(1).max(10) }).strict();
const scopeSchema = z.object({ projectKey: z.string().min(1).max(128) });
const toolSchema = z.object({ origin:z.string().regex(/^http:\/\/127\.0\.0\.1:\d+$/), previewId: z.string().uuid(), digest: z.string().length(64), plan: planSchema }).strict();
type Plan = z.infer<typeof planSchema>;
type Snapshot = { source:Awaited<ReturnType<typeof sourceRevision>>; digest: string; files: Map<string, Buffer>; directory: string };
type Preview = { id: string; projectKey: string; root: string; snapshot: Snapshot; origin: string; server: ChildProcess; expires: number; timer: ReturnType<typeof setTimeout> };
const artifactSchema=z.object({id:z.string().uuid(),projectKey:scopeSchema.shape.projectKey,previewId:z.string().uuid(),digest:z.string().length(64),createdAt:z.string().datetime(),origin:z.string().regex(/^http:\/\/127\.0\.0\.1:\d+$/),directory:relative,plan:planSchema,source:z.object({head:z.string().max(64),digest:z.string().length(64)}).nullable(),status:z.enum(['running','passed','failed']),error:z.string().max(128).optional(),screenshot:z.string().max(2800000).regex(/^[A-Za-z0-9+/]*={0,2}$/).optional(),screenshotDigest:z.string().length(64).optional(),feedback:z.array(z.object({id:z.string().uuid(),text:z.string().max(2000),createdAt:z.string().datetime()}).strict()).max(1)}).strict();
type Artifact=z.infer<typeof artifactSchema>;

const mime: Record<string,string> = { '.html':'text/html', '.js':'text/javascript', '.mjs':'text/javascript', '.css':'text/css', '.json':'application/json', '.png':'image/png', '.jpg':'image/jpeg', '.jpeg':'image/jpeg', '.svg':'image/svg+xml', '.webp':'image/webp', '.ico':'image/x-icon', '.woff':'font/woff', '.woff2':'font/woff2', '.txt':'text/plain' };

/** Immutable, explicitly selected static output. No shell, symlinks, hidden files or repository-wide HTTP access. */
async function snapshot(root: string, directory: string): Promise<Snapshot> {
  relative.parse(directory);
  const base = path.join(root, directory), files = new Map<string,Buffer>();
  let total = 0, entries = 0;
  async function walk(dir: string, depth: number): Promise<void> {
    if (depth > 12) throw new Error('PREVIEW_TOO_LARGE');
    for (const entry of (await readdir(path.join(base,dir),{withFileTypes:true})).sort((a,b)=>a.name.localeCompare(b.name))) {
      if(++entries>2048)throw new Error('PREVIEW_TOO_LARGE');
      if (entry.name.startsWith('.') || entry.name === 'node_modules') continue;
      const name = dir ? `${dir}/${entry.name}` : entry.name;
      if (entry.isSymbolicLink()) throw new Error('PREVIEW_SYMLINK_REJECTED');
      if (entry.isDirectory()) await walk(name,depth+1);
      else if (entry.isFile() && mime[path.extname(name).toLowerCase()]) {
        const {contents} = await readRegularFileNoFollow(path.join(base,name),{label:'Preview file',maxBytes:2*1024*1024,requireSingleLink:true});
        total+=contents.length;
        if (total>16*1024*1024 || files.size>=512) throw new Error('PREVIEW_TOO_LARGE');
        files.set(name,contents);
      }
    }
  }
  await walk('',0);
  if (!files.has('index.html')) throw new Error('PREVIEW_INDEX_REQUIRED');
  return {directory,files,source:await sourceRevision(root),digest:hash(JSON.stringify([...files].map(([name,bytes])=>[name,hash(bytes)])))};
}

const browserEnvironment=()=>Object.fromEntries(Object.entries(process.env).filter(([k,v])=>v!==undefined&&['PATH','HOME','TMPDIR','TEMP','TMP','SystemRoot'].includes(k))) as Record<string,string>;
async function stopWorker(child:ChildProcess){
  if(!child.pid||child.exitCode!==null||child.signalCode!==null)return;
  await new Promise<void>(resolve=>{
    const timer=setTimeout(()=>child.kill('SIGKILL'),1500);
    child.once('exit',()=>{clearTimeout(timer);resolve();});
    child.kill('SIGTERM');
  });
}
async function startWorker(snapshot:Snapshot):Promise<{child:ChildProcess;port:number}>{
  const built=fileURLToPath(new URL('./preview/preview-server.js',import.meta.url));
  const entry=existsSync(built)?built:fileURLToPath(new URL('./preview-server.ts',import.meta.url));
  const child=fork(entry,[],{execPath:process.execPath,execArgv:process.versions.bun?['--no-env-file']:[],env:browserEnvironment(),stdio:['ignore','ignore','ignore','ipc']});
  try {
    const port=await new Promise<number>((resolve,reject)=>{
      const timer=setTimeout(()=>{cleanup();reject(Error('PREVIEW_START_TIMEOUT'));},5000);
      const cleanup=()=>{clearTimeout(timer);child.off('error',failed);child.off('exit',failed);child.off('message',ready);};
      const failed=()=>{cleanup();reject(Error('PREVIEW_SERVER_FAILED'));};
      const ready=(message:unknown)=>{const result=z.object({port:z.number().int().min(1).max(65535)}).safeParse(message);if(!result.success){failed();return;}cleanup();resolve(result.data.port);};
      child.once('message',ready);child.once('error',failed);child.once('exit',failed);
      child.send({files:[...snapshot.files].map(([name,bytes])=>[name,bytes.toString('base64')])},error=>{if(error)failed();});
    });
    return{child,port};
  }catch(error){await stopWorker(child);throw error;}
}

export async function createPreviewController(options: { directory: string; root: (key: string)=>Promise<string>; allowed: (key:string)=>void }) {
  options.directory=await ensureProjectPrivateDirectory(options.directory);
  const previews = new Map<string,Preview>(), tickets = new Map<string,{key:string;root:string;snapshot:Snapshot;expires:number}>();
  const artifacts = new Map<string,Artifact>(), browsers = new Map<string,Browser>(), busy = new Set<string>();
  let closed = false, starting = 0, storedBytes = 0;
  const sizes=new Map<string,number>();
  const generations = new Map<string,number>();
  // Interrupted checks are never replayed. Completed immutable evidence is reloadable after restart.
  for (const entry of (await readdir(options.directory)).filter(n=>/^[a-f0-9-]{36}\.json$/.test(n)).slice(-500)) {
    try {
      const {contents}=await readRegularFileNoFollow(path.join(options.directory,entry),{label:'Artifact',maxBytes:3*1024*1024,requireSingleLink:true});
      const a=artifactSchema.parse(JSON.parse(contents.toString()));
      if(storedBytes+contents.length>64*1024*1024)throw new Error('ARTIFACT_LIMIT');
      if(a.screenshot && hash(Buffer.from(a.screenshot,'base64'))!==a.screenshotDigest)throw new Error('ARTIFACT_DIGEST_MISMATCH');
      storedBytes+=contents.length;sizes.set(a.id,contents.length);
      if(a.status==='running'){a.status='failed';a.error='BROWSER_CHECK_INTERRUPTED';}
      if(a.id+'.json'===entry && typeof a.projectKey==='string' && Array.isArray(a.feedback)) artifacts.set(a.id,a);
    } catch { /* Invalid evidence is not presented as verified. */ }
  }
  const check=(key:string)=>{if(closed)throw new Error('PREVIEW_CLOSED');options.allowed(key);};
  const save=async(a:Artifact,replace=false)=>{
    const text=JSON.stringify(artifactSchema.parse(a)),size=Buffer.byteLength(text),old=sizes.get(a.id)??0;
    if(storedBytes-old+size>64*1024*1024||(!replace&&artifacts.size>=500))throw new Error('ARTIFACT_LIMIT');
    storedBytes+=size-old;sizes.set(a.id,size);
    const target=path.join(options.directory,a.id+'.json'),temp=replace?`${target}.${randomUUID()}.tmp`:target;
    try{
      const file=await open(temp,'wx',0o600);try{await file.writeFile(text);await file.sync();}finally{await file.close();}
      if(replace)await rename(temp,target);
      await syncPrivateDirectory(options.directory,'ARTIFACT_DIRECTORY_UNSAFE');artifacts.set(a.id,structuredClone(a));
    }catch(error){storedBytes+=old-size;sizes.set(a.id,old);if(replace)await unlink(temp).catch(()=>{});throw error;}
  };
  async function stop(key:string) {
    generations.set(key,(generations.get(key)??0)+1);
    for(const p of previews.values())if(p.projectKey===key){previews.delete(p.id);clearTimeout(p.timer);await browsers.get(p.id)?.close().catch(()=>{});await stopWorker(p.server);}
  }
  async function verify(key:string,input:unknown,signal?:AbortSignal) {
    check(key);if(signal?.aborted)throw new Error('PREVIEW_CANCELLED');await options.root(key);check(key);
    if(artifacts.size>=500)throw new Error('ARTIFACT_LIMIT');
    const request=toolSchema.parse(input),p=previews.get(request.previewId);
    if(!p||p.projectKey!==key||p.snapshot.digest!==request.digest||p.origin!==request.origin||p.expires<Date.now())throw new Error('PREVIEW_SCOPE_CHANGED');
    if(busy.has(p.id))throw new Error('PREVIEW_BUSY');
    busy.add(p.id);
    const a:Artifact={id:randomUUID(),projectKey:key,previewId:p.id,digest:p.snapshot.digest,directory:p.snapshot.directory,origin:p.origin,source:p.snapshot.source,createdAt:new Date().toISOString(),plan:request.plan,status:'running',feedback:[]};
    try{await save(a);}catch(error){busy.delete(p.id);throw error;}
    let browser:Browser|undefined;
    const abort=()=>{void browsers.get(p.id)?.close().catch(()=>{});};
    signal?.addEventListener('abort',abort,{once:true});
    const deadline=setTimeout(()=>{void browsers.get(p.id)?.close();},30000);
    try {
      browser=await chromium.launch({headless:true,timeout:10000,env:browserEnvironment()});
      browsers.set(p.id,browser);
      if(signal?.aborted)throw new Error('PREVIEW_CANCELLED');
      if(!previews.has(p.id))throw new Error('PREVIEW_STOPPED');
      const context=await browser.newContext({viewport:{width:1280,height:800},serviceWorkers:'block',acceptDownloads:false});
      await context.route('**/*',route=>new URL(route.request().url()).origin===p.origin?route.continue():route.abort('blockedbyclient'));
      await context.routeWebSocket('**/*',socket=>socket.close());
      const page=await context.newPage();
      context.on('page',popup=>{if(popup!==page)void popup.close();});
      page.setDefaultTimeout(3000);
      await page.goto(new URL(request.plan.path,p.origin).href,{waitUntil:'load',timeout:10000});
      for(const step of request.plan.steps){
        if(new URL(page.url()).origin!==p.origin)throw new Error('PREVIEW_NAVIGATION_REJECTED');
        const locator=page.locator(step.selector);
        if(step.kind==='click')await locator.click();
        else {
          await locator.waitFor({state:'visible'});
          if(!(await locator.innerText()).includes(step.text))throw new Error('PREVIEW_ASSERTION_FAILED');
        }
      }
      if(new URL(page.url()).origin!==p.origin)throw new Error('PREVIEW_NAVIGATION_REJECTED');
      const screenshot=await page.screenshot({type:'png',timeout:5000});
      if(screenshot.length>2*1024*1024)throw new Error('PREVIEW_SCREENSHOT_TOO_LARGE');
      a.screenshot=screenshot.toString('base64');a.screenshotDigest=hash(screenshot);a.status='passed';
    } catch(error) {
      // Do not store browser logs, page content, credentials or environment in error messages.
      a.status='failed';a.error=signal?.aborted?'PREVIEW_CANCELLED':error instanceof Error && /^PREVIEW_[A-Z_]+$/.test(error.message)?error.message:'BROWSER_CHECK_FAILED_OR_BROWSER_UNAVAILABLE';
    } finally { signal?.removeEventListener('abort',abort);clearTimeout(deadline);await browser?.close().catch(()=>{a.status='failed';a.error='BROWSER_CLEANUP_FAILED';});browsers.delete(p.id);busy.delete(p.id); }
    try{await save(a,true);}catch{delete a.screenshot;delete a.screenshotDigest;a.status='failed';a.error='ARTIFACT_SAVE_FAILED';await save(a,true);}
    return {artifactId:a.id,status:a.status,digest:a.digest,...(a.error?{error:a.error}:{})};
  }
  async function list(key:string){
    const root=await options.root(key), currentSource=await sourceRevision(root), stamps=new Map<string,string>();
    const evidence=[];
    for(const a of [...artifacts.values()].filter(a=>a.projectKey===key).sort((a,b)=>a.createdAt.localeCompare(b.createdAt)).slice(-100)){
      if(!stamps.has(a.directory)){try{stamps.set(a.directory,(await snapshot(root,a.directory)).digest);}catch{stamps.set(a.directory,'unavailable');}}
      const {screenshot,...metadata}=a;evidence.push({...metadata,hasScreenshot:Boolean(screenshot),stale:stamps.get(a.directory)!==a.digest||!a.source||!currentSource||a.source.digest!==currentSource.digest});
    }
    return {previews:[...previews.values()].filter(p=>p.projectKey===key).map(p=>({id:p.id,origin:p.origin,digest:p.snapshot.digest,directory:p.snapshot.directory,expires:p.expires,busy:busy.has(p.id)})),artifacts:evidence};
  }
  return {
    stop,
    async close(){closed=true;tickets.clear();await Promise.all([...new Set([...previews.values()].map(p=>p.projectKey))].map(stop));},
    async action(input:unknown):Promise<unknown>{
      const base=z.object({action:z.string(),projectKey:scopeSchema.shape.projectKey}).passthrough().parse(input);check(base.projectKey);
      const key=base.projectKey,root=await options.root(key);
      switch(base.action){
        case 'list':return list(key);
        case 'review':{
          const v=scopeSchema.extend({action:z.literal('review'),directory:relative}).strict().parse(input);
          for(const [id,t]of tickets)if(t.expires<Date.now())tickets.delete(id);
          if(tickets.size>=8)throw new Error('PREVIEW_REVIEW_LIMIT');
          const s=await snapshot(root,v.directory),ticket=randomUUID();tickets.set(ticket,{key,root,snapshot:s,expires:Date.now()+300000});
          return {ticket,directory:v.directory,digest:s.digest,source:s.source,files:[...s.files.keys()],bytes:[...s.files.values()].reduce((n,b)=>n+b.length,0),consequence:'Serves these captured static files on a separate loopback origin for 30 minutes. Repository scripts are not executed. Browser checks require a separate approval.'};
        }
        case 'start':{
          const v=scopeSchema.extend({action:z.literal('start'),ticket:z.string().uuid()}).strict().parse(input),t=tickets.get(v.ticket);tickets.delete(v.ticket);
          if(!t||t.key!==key||t.root!==root||t.expires<Date.now()||(await snapshot(root,t.snapshot.directory)).digest!==t.snapshot.digest)throw new Error('PREVIEW_REVIEW_CHANGED');
          check(key);if(previews.size+starting>=2)throw new Error('PREVIEW_LIMIT');
          starting++;const generation=generations.get(key)??0;
          try {
          const server=await startWorker(t.snapshot);
          if(closed||(generations.get(key)??0)!==generation){await stopWorker(server.child);throw new Error('PREVIEW_STOPPED');}
          const id=randomUUID(),expires=Date.now()+1800000;
          const timer=setTimeout(()=>{void stop(key);},1800000);timer.unref();
          server.child.once('exit',()=>{previews.delete(id);clearTimeout(timer);void browsers.get(id)?.close();});
          previews.set(id,{id,projectKey:key,root,snapshot:t.snapshot,origin:`http://127.0.0.1:${server.port}`,server:server.child,expires,timer});return list(key);
          } finally {starting--;}
        }
        case 'stop':scopeSchema.extend({action:z.literal('stop')}).strict().parse(input);await stop(key);return list(key);
        case 'verify':{
          const v=scopeSchema.extend({action:z.literal('verify'),request:toolSchema}).strict().parse(input);return verify(key,v.request);
        }
        case 'artifact':{
          const v=scopeSchema.extend({action:z.literal('artifact'),id:z.string().uuid()}).strict().parse(input),a=artifacts.get(v.id);if(!a||a.projectKey!==key)throw new Error('ARTIFACT_NOT_FOUND');return a;
        }
        case 'feedback':{
          const v=scopeSchema.extend({action:z.literal('feedback'),id:z.string().uuid(),digest:z.string().length(64),text:z.string().trim().min(1).max(2000)}).strict().parse(input),a=artifacts.get(v.id);
          if(!a||a.projectKey!==key||a.digest!==v.digest)throw new Error('ARTIFACT_NOT_FOUND');
          // Feedback is another immutable artifact, anchored to the original evidence ID and digest.
          const {screenshot,screenshotDigest,...metadata}=a;const feedback={...metadata,id:randomUUID(),createdAt:new Date().toISOString(),feedback:[{id:a.id,text:v.text,createdAt:new Date().toISOString()}]};await save(feedback);return {id:feedback.id};
        }
        default:throw new Error('PREVIEW_ACTION_INVALID');
      }
    },
    mcp(key:string):Pick<CreateCodingHarnessOptions,'mcpConfiguration'|'mcpClients'>{
      return {mcpConfiguration:normalizeHarnessMcpConfiguration({schemaVersion:1,servers:[{name:'preview',transport:'custom',includeTools:['verify'],permissions:['network'],callToolTimeoutMs:45000}]}),mcpClients:{preview:{
        async listTools(){return [{name:'verify',description:'Verify an explicitly authorized static preview. Obtain previewId, origin and digest from the user. Each call requires approval. Only relative navigation, clicks, visible text assertions and screenshot evidence are supported. No shell or arbitrary JavaScript.',inputSchema:JSON.parse(JSON.stringify(z.toJSONSchema(toolSchema)))}];},
        async callTool(request,callOptions){return {content:[{type:'text',text:JSON.stringify(await verify(key,request.arguments,callOptions?.abortSignal))}]};}
      }}};
    }
  };
}
