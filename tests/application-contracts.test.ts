import {test, expect} from 'bun:test';
import {mkdtemp, rm} from 'node:fs/promises';
import {startApplicationCoordinator} from '../packages/core/src/application/coordinator.js';
import {connectCoordinator, ApplicationCoordinatorError} from '../packages/core/src/application/coordinator-client.js';
import {startAssistantHost} from '../packages/core/src/application/assistant/host.js';
import {createMockLanguageModel} from '@zhivex-ai/agents/testing';

test('application negotiates versions/capabilities and projects versioned secret-free loaded bindings', async () => {
  const directory = await mkdtemp('/tmp/zhx-contract-');
  let stored: string | null = null;
  const options = {secrets:{async read(){return stored;}, async write(value: string){stored=value;}}, validateProvider:async()=>{},
    startHost:(input:Parameters<typeof startAssistantHost>[0])=>startAssistantHost({...input,engine:{...input.engine,modelInstance:createMockLanguageModel()}})};
  let owner = await startApplicationCoordinator(directory,options);
  try {
    await expect(connectCoordinator(directory,{versions:[2]})).rejects.toMatchObject({code:'COORDINATOR_VERSION_UNSUPPORTED',detail:{recovery:'upgrade'}});
    await expect(connectCoordinator(directory,{requiredCapabilities:['absent']})).rejects.toBeInstanceOf(ApplicationCoordinatorError);
    const client = await connectCoordinator(directory,{requiredCapabilities:['application.catalog']});
    expect(client.protocol).toMatchObject({version:1,projectionVersion:1,activityVersion:1});
    const initial = await client.catalog();
    expect(initial).toMatchObject({schemaVersion:1,agents:[],runtimes:[],locked:false});
    expect((await client.catalog()).revision).toBe(initial.revision);
    await client.call('action',{name:'begin',value:{name:'Personal'}});
    await client.call('action',{name:'provider',value:{baseURL:'https://example.invalid/v1',apiKey:'private-contract-key',model:'mock'}});
    await client.call('action',{name:'tools',value:{daily:true}});
    await client.call('action',{name:'start',value:{}});
    const catalog = await client.catalog();
    expect(catalog.revision).not.toBe(initial.revision);
    expect(catalog.generation).toBe(initial.generation);
    expect(catalog.runtimes[0]?.binding.tools).toContain('daily_write_create_task');
    expect(catalog.runtimes[0]?.binding.tools).not.toContain('apply_reviewed_replacement');
    expect(catalog.runtimes[0]?.binding.fingerprint).toMatch(/^sha256:/);
    expect(JSON.stringify(catalog)).not.toMatch(/private-contract-key|credentialsPath|socketPath|apiKey|encryptionKey/);
    await expect(client.call('personal-state',{projectId:'another-scope'})).rejects.toMatchObject({detail:{schemaVersion:1}});
    await owner.close(); owner=await startApplicationCoordinator(directory,options);
    const restarted=await connectCoordinator(directory), next=await restarted.catalog();
    expect(next.generation).not.toBe(initial.generation);
    expect(next.runtimes[0]?.binding).toEqual(catalog.runtimes[0]?.binding);
  } finally {await owner.close(); await rm(directory,{recursive:true,force:true});}
});
