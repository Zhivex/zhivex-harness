import {test,expect} from 'bun:test';
import {mkdtemp,mkdir,rm} from 'node:fs/promises';
import {execFileSync} from 'node:child_process';
import {randomUUID} from 'node:crypto';
import {createMockLanguageModel} from '@zhivex-ai/agents/testing';
import {startAssistantHost} from '../src/host.js';
test('persistent activity reads canonical completed runs and pausing rejects new project runs',async()=>{
 const directory=await mkdtemp('/tmp/desktop-work-');await mkdir(directory+'/repo');execFileSync('git',['init','-q',directory+'/repo']);
 const host=await startAssistantHost({directory:directory+'/state',ownerId:'work-test',engine:{modelInstance:createMockLanguageModel({streamEvents:[[{type:'text-delta',textDelta:'Done'},{type:'finish',finishReason:'stop'}]]}),model:'mock'},coding:{execution:'local',configurationId:'work-test'}});
 try{const app=host.application!;const p=await app.client.registerProject(await app.selectProject(directory+'/repo'));if(!p.ok)throw Error(p.error.code);const b=await app.client.createConversation({context:{kind:'project',projectKey:p.data.projectKey},idempotencyKey:randomUUID()});if(!b.ok)throw Error(b.error.code);
 const result=await app.send({conversationId:b.data.conversationId,prompt:'Complete',key:randomUUID()});expect(result.ok).toBe(true);
 const work=await app.work();expect(work.some(w=>w.conversationId===b.data.conversationId&&w.status==='completed')).toBe(true);
 await host.controlClose('pause');await expect(app.send({conversationId:b.data.conversationId,prompt:'Must not start',key:randomUUID()})).rejects.toThrow('LOCAL_SERVICE_HTTP_503');await host.controlClose('resume');
 }finally{await host.close();await rm(directory,{recursive:true,force:true});}
});
