import { expect,test } from 'bun:test';
import { parseCliArgs } from '../src/cli/arguments.js';
import { governanceReportCli } from '../src/cli/governance-report.js';
import { resolveHarnessConfig } from '../src/runtime/config.js';
import type { AgentRunState,AgentRunStore } from '@zhivex-ai/core';
const store:AgentRunStore={load:async()=>({runId:'r',status:'completed',messages:[],pendingApprovals:[],metadata:{},childRuns:[]} as unknown as AgentRunState),save:async()=>{throw new Error('write');}};
test('report command parses session, envelope and JSON without changing existing export',()=>{
 expect(parseCliArgs(['runs','report','r','envelope.json','--session','s','--json'])).toMatchObject({runsCommand:'report',runId:'r',reportEnvelopePath:'envelope.json',sessionId:'s',json:true});
 expect(parseCliArgs(['runs','export','r','--json']).runsCommand).toBe('export');
 expect(()=>parseCliArgs(['runs','report'])).toThrow('requires a runId');
 expect(()=>parseCliArgs(['runs','report','r','one','two'])).toThrow('unexpected');
 expect(()=>parseCliArgs(['runs','report','r','--yes'])).toThrow();
});
test('report command defaults to Markdown and emits strict JSON when requested',async()=>{
 const options=parseCliArgs(['runs','report','r']);const config=resolveHarnessConfig(options);
 expect(await governanceReportCli(options,config,store)).toContain('# Execution and governance report');
 const json=JSON.parse(await governanceReportCli({...options,json:true},config,store));
 expect(json.kind).toBe('harness-governance-report');expect(json.runs[0].delivery.status).toBe('unknown');
});
