import path from 'node:path';
import type { AgentRunStore } from '@zhivex-ai/core';
import type { HarnessConfig } from '../runtime/config.js';
import type { CliOptions } from './arguments.js';
import { CliUsageError } from './arguments.js';
import { exportHarnessGovernanceReport, renderHarnessGovernanceMarkdown } from '../persistence/governance-report.js';
import { openCliSessionStore } from '../persistence/sessions.js';
import { openHarnessActivityStore } from '../client/service-events.js';
import { readRegularFileNoFollow } from '../workspace/file-security.js';

/** Provider-free report command; the optional envelope is bounded data, never a command. */
export async function governanceReportCli(options:CliOptions,config:HarnessConfig,store:AgentRunStore):Promise<string> {
  let index:Awaited<ReturnType<typeof openCliSessionStore>>|undefined;
  let history:Awaited<ReturnType<typeof openHarnessActivityStore>>|undefined;
  try {
    const envelopes:unknown[]=[];
    if(options.reportEnvelopePath) {
      const data=await readRegularFileNoFollow(path.resolve(options.reportEnvelopePath),{label:'Governance envelope',maxBytes:256*1024});
      try {envelopes.push(JSON.parse(data.contents.toString('utf8')));} catch {throw new CliUsageError('Governance envelope must contain valid JSON.');}
    }
    if(options.sessionId) {
      index=await openCliSessionStore({workspace:config.workspace,stateDirectory:config.stateDirectory,scope:config.scope});
      history=await openHarnessActivityStore(config);
    }
    const report=await exportHarnessGovernanceReport(store,config.scope,options.runId!,{changeEnvelopes:envelopes,
      ...(index && history && options.sessionId?{session:{id:options.sessionId,index,history}}:{})});
    return options.json?JSON.stringify(report,null,2)+'\n':renderHarnessGovernanceMarkdown(report);
  } finally {history?.close();index?.close();}
}
