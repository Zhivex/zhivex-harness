import { expect, test } from 'bun:test';
import { createTerminalHost } from '../src/terminal.js';
import type { openAssistantApplication } from '../src/application.js';
test('human terminal uses registered roots, rejects path injection, scopes access and pauses input',async()=>{
 const calls: {method:string;input:Record<string,unknown>|undefined}[]=[];let registered=true;
 const app={async terminalRoot(key:string){if(key!=='project'||!registered)throw new Error('PROJECT_NOT_FOUND');return '/private/tmp/project';}};
 const terminal=createTerminalHost({async request(method,input){calls.push({method,input});return {};}},()=>app);
 await expect(terminal.action({action:'open',projectKey:'project',cwd:'/etc',cols:80,rows:24})).rejects.toThrow();expect(calls).toHaveLength(0);
 const session=await terminal.action({action:'open',projectKey:'project',cols:80,rows:24}) as {id:string};expect(calls[0]?.input?.cwd).toBe('/private/tmp/project');
 registered=false;await expect(terminal.action({action:'write',id:session.id,data:'secret'})).rejects.toThrow();registered=true;
 terminal.pause(true);await expect(terminal.action({action:'write',id:session.id,data:'ls\r'})).rejects.toThrow('APPLICATION_DRAINING');
 await terminal.action({action:'read',id:session.id,after:0});await terminal.close();expect(calls.map(c=>c.method)).toEqual(['terminal-open','terminal-read','terminal-close-all']);
});
test('terminal capacity includes ambiguous spawns and never retries them',async()=>{
 let calls=0;const app={async terminalRoot(){return '/private/tmp/project';}};
 const terminal=createTerminalHost({async request(){calls++;throw new Error('timeout');}},()=>app);
 for(let i=0;i<8;i++)await expect(terminal.action({action:'open',projectKey:'project',cols:80,rows:24})).rejects.toThrow('timeout');
 await expect(terminal.action({action:'open',projectKey:'project',cols:80,rows:24})).rejects.toThrow('TERMINAL_CAPACITY');expect(calls).toBe(8);
});
