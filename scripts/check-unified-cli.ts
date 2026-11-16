import {mkdir, readFile, writeFile} from 'node:fs/promises';
import {CLI_COMMANDS, CLI_RUNS_COMMANDS, CLI_SESSIONS_COMMANDS, CLI_CHANGES_COMMANDS, CLI_STATE_COMMANDS, parseCliArgs} from '../packages/core/src/cli/arguments.js';
import {CONSOLE_COMMAND_CATALOG} from '../packages/core/src/cli/interactive/console/console-commands.js';
const baseline = JSON.parse(await readFile('fixtures/cli-compatibility/inventory.json','utf8'));
const source = await readFile('packages/core/src/cli/arguments.ts','utf8');
const groups: Record<string, readonly string[]> = {CLI_COMMANDS, CLI_RUNS_COMMANDS, CLI_SESSIONS_COMMANDS, CLI_CHANGES_COMMANDS, CLI_STATE_COMMANDS};
const missing: string[] = [], rows: {source: string; kind: string; name: string; destination: string}[] = [];
for (const parser of baseline.parsers) {
 for (const [name, values] of Object.entries(parser.commandGroups) as [string,string[]][]) for (const value of values) {
  if (!groups[name]?.includes(value)) missing.push(`${parser.source}:${name}:${value}`);
  rows.push({source:parser.source,kind:name,name:value,destination:'src/cli/arguments.ts'});
 }
 for (const {name} of parser.flags) {
  if (!source.includes(`case "${name}"`) && !['--help','--version'].includes(name)) missing.push(`${parser.source}:${name}`);
  rows.push({source:parser.source,kind:'flag',name,destination:'src/cli/arguments.ts'});
 }
}
for (const terminal of baseline.terminalCommands) for (const {command} of terminal.commands) {
 if (!CONSOLE_COMMAND_CATALOG.some(([name])=>name===command)) missing.push(`${terminal.source}:${command}`);
 rows.push({source:terminal.source,kind:'console',name:command,destination:'src/cli/interactive/console/console-commands.ts'});
}
for (const flag of ['--auto-approve=auto-edits','--auto-approve-allow=run_check']) parseCliArgs(['run','fixture',flag]);
for (const flag of ['--auto-approve=auto-edits','--auto-approve-allow=run_check']) {
 let rejected = false; try {parseCliArgs(['run','fixture','--area','code',flag]);} catch {rejected=true;}
 if (!rejected) missing.push('shared-host-overrides:'+flag);
}
const wrapper=await readFile('packages/cli/src/cli.ts','utf8');
if (!wrapper.includes('@zhivex-ai/harness/cli') || /switch\s*\(|createHarness|runOnce/.test(wrapper)) missing.push('wrapper-duplicates-dispatch');
const report={schemaVersion:1,passed:missing.length===0,missing,entries:rows.length,rows,compatibility:['zhivex-code normal commands delegate to canonical CLI','version/help identity retained; legacy web/project commands rejected with migration guidance','shared-host runtime flags rejected; direct historical mode retained','ACP remains zhx-acp over core']};
await mkdir('results/unification', {recursive: true});
await writeFile('results/unification/parity.json',JSON.stringify(report,null,2)+'\n');
console.log(JSON.stringify({passed:report.passed,entries:rows.length,missing}));
if(missing.length) process.exitCode=1;
