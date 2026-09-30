/** Offline protocol preparation and journal summary. Never runs a tool or provider. */
import path from 'node:path';
import {writeFile} from 'node:fs/promises';
import {readRegularFileNoFollow} from '../src/workspace/file-security.js';
import {compileCompetitivePilotPlan,summarizeCompetitivePilot} from './acceptance/pilot-protocol.js';

const [command,planPath,inputOrOutput,summaryOutput]=process.argv.slice(2);
const read=async(file:string,maximum:number)=>(await readRegularFileNoFollow(path.resolve(file),{label:'Pilot input',maxBytes:maximum})).contents.toString('utf8');
try {
 if(!planPath || !inputOrOutput || !['lock','summarize'].includes(command??''))throw new Error('Usage');
 const plan=JSON.parse(await read(planPath,64*1024));
 let output:unknown,destination:string;
 if(command==='lock') {
  if(summaryOutput)throw new Error('Usage');
  output=compileCompetitivePilotPlan(plan);destination=inputOrOutput;
 } else {
  if(!summaryOutput)throw new Error('Usage');
  const text=await read(inputOrOutput,16*1024*1024);
  const lines=text.trim()?text.trim().split('\n'):[];
  if(lines.length>7680)throw new Error('Journal capacity');
  output=summarizeCompetitivePilot(plan,lines.map(line=>JSON.parse(line)));destination=summaryOutput;
 }
 await writeFile(path.resolve(destination),JSON.stringify(output,null,2)+'\n',{flag:'wx',mode:0o600});
 process.stdout.write('Pilot document written. No campaign was executed.\n');
} catch {
 process.stderr.write('Pilot validation failed. Expected: lock <plan.json> <new-lock.json> or summarize <plan.json> <attempts.jsonl> <new-summary.json>. Existing outputs are never overwritten.\n');
 process.exitCode=1;
}
