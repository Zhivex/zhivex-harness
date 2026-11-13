import { test, expect } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { createDesktopLifecycle } from '../src/desktop-lifecycle.js';
import type { AssistantWorkItem } from '../src/application-contracts.js';
const waitFor = async (predicate: () => boolean) => { const deadline = Date.now() + 2000; while (!predicate()) { if (Date.now() > deadline) throw new Error('timeout'); await new Promise(r => setTimeout(r, 10)); } };
async function fixture() {
  const directory = await mkdtemp('/tmp/lifecycle-test-');
  let active = true, closed = false, paused = false, cancels = 0, permission = 'denied';
  let work: AssistantWorkItem[] = [];
  const requests: string[] = [];
  const lifecycle = await createDesktopLifecycle({ directory, pollMs: 60000,
    native: { async request(method) { requests.push(method); return { permission }; } },
    async control(op) { if (op === 'cancel') { cancels++; active = false; } else paused = op === 'pause'; return active; },
    async work() { return work; }, async close() { closed = true; },
  });
  return { lifecycle, requests, get closed() { return closed; }, get paused() { return paused; }, get cancels() { return cancels; }, finish() { active = false; }, allow() { permission = 'granted'; }, work(value: AssistantWorkItem[]) { work = value; }, async cleanup() { lifecycle.stop(); await rm(directory, { recursive: true, force: true }); } };
}
test('drain pauses admission, keeps work alive, and closes only after completion', async () => {
 const f = await fixture(); try { f.lifecycle.requestQuit(); await f.lifecycle.action({action:'drain'}); await waitFor(()=>f.paused); expect(f.closed).toBe(false); expect(f.cancels).toBe(0); f.finish(); await waitFor(()=>f.closed); expect(f.requests).toEqual(['terminal-close-all']); } finally { await f.cleanup(); }
});
test('stay resumes admission and supersedes a pending drain', async () => {
 const f = await fixture(); try { await f.lifecycle.action({action:'drain'}); await f.lifecycle.action({action:'stay'}); f.finish(); await new Promise(r=>setTimeout(r,150)); expect(f.closed).toBe(false); expect(f.paused).toBe(false); expect(f.lifecycle.state().phase).toBe('running'); } finally { await f.cleanup(); }
});
test('cancel can replace drain and cancels exactly once', async () => {
 const f = await fixture(); try { await f.lifecycle.action({action:'drain'}); await waitFor(()=>f.paused); await f.lifecycle.action({action:'cancel'}); await waitFor(()=>f.closed); expect(f.cancels).toBe(1); } finally { await f.cleanup(); }
});
test('notifications require permission and include newly completed runs between polls', async () => {
 const f = await fixture(); try { await f.lifecycle.action({action:'enable-notifications'}); expect(f.lifecycle.state().notifications).toBe(false); f.allow(); await f.lifecycle.action({action:'enable-notifications'}); await f.lifecycle.poll(); f.work([{id:'run',title:'private task',status:'completed',attention:false} as AssistantWorkItem]); await f.lifecycle.poll(); await f.lifecycle.poll(); expect(f.requests.filter(r=>r==='notification-show')).toHaveLength(1); } finally { await f.cleanup(); }
});
test('failed admission pause leaves the application available for inspection', async () => {
 const directory = await mkdtemp('/tmp/lifecycle-failure-'); let closed=false;
 const lifecycle=await createDesktopLifecycle({directory,native:{async request(){return {}; }},async control(op){if(op!=='resume')throw new Error('busy');return false;},async work(){return [];},async close(){closed=true;}});
 try {await lifecycle.action({action:'cancel'});await waitFor(()=>lifecycle.state().phase==='requested');expect(closed).toBe(false);expect(lifecycle.state().error).not.toBe('');}finally{lifecycle.stop();await rm(directory,{recursive:true,force:true});}
});
test('workspace selection survives a host restart without replaying work',async()=>{
 const directory=await mkdtemp('/tmp/lifecycle-selection-');let calls=0;
 const options={directory,native:{async request(){calls++;return {};}},async control(){return false;},async work(){return [];},async close(){}};
 const first=await createDesktopLifecycle(options);try{await first.action({action:'select-view',selection:{project:'registered',conversation:'saved'}});first.stop();const next=await createDesktopLifecycle(options);try{expect(next.state().selection).toEqual({project:'registered',conversation:'saved'});expect(next.state().phase).toBe('running');expect(calls).toBe(0);}finally{next.stop();}}finally{first.stop();await rm(directory,{recursive:true,force:true});}
});
