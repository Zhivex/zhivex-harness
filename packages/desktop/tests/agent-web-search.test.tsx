import {expect, test} from 'bun:test';
import {renderToStaticMarkup} from 'react-dom/server';
import {AgentModel} from '../src/unified/AgentModel.js';
import type {AssistantSetupState} from '../src/unified/bridge.js';
const profile = {id:'existing', name:'My assistant', connectionId:'connection', active:true, provider:{kind:'openai-compatible', model:'test', webSearch:true, canEnableWebSearch:true}} as AssistantSetupState['profiles'][number];
function render(supported: boolean, busy = false) {
 const connections = [{id:'connection',label:'OpenAI',canEnableWebSearch:supported}] as AssistantSetupState['connections'];
 return renderToStaticMarkup(<AgentModel profile={profile} connections={connections} busy={busy} act={async()=>true}/>);
}
test('saved web search state is visible and explains preservation and cost',()=>{
 const html=render(true);
 expect(html).toContain('Search the internet');
 expect(html).toContain('checked=""');
 expect(html).toContain('Your existing chats stay with this assistant');
 expect(html).toContain('provider charges');
});
test('unsupported connections and busy updates cannot toggle search',()=>{
 expect(render(false)).toContain('type="checkbox" disabled=""');
 expect(render(false)).not.toContain('checked=""');
 expect(render(true,true)).toContain('type="checkbox" disabled=""');
});
