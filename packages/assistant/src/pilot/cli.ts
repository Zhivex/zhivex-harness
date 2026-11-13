#!/usr/bin/env node
import {fileURLToPath} from 'node:url';
import {pilotDiagnostics} from './diagnostics.js';
import {verifyPilotManifest} from './manifest.js';
import {migrationPreflight,adoptMigration} from './migration.js';
async function main(){
 const [command,...args]=process.argv.slice(2),flags:Record<string,string>={};
 for(let i=0;i<args.length;i+=2){const key=args[i],value=args[i+1];if(!key||!['--runtime','--workspace','--backup','--owner','--receipt'].includes(key)||!value||value.startsWith('--')||flags[key])throw Error('PILOT_USAGE_INVALID');flags[key]=value;}
 if(command==='doctor'&&!args.length)return pilotDiagnostics();
 if(command==='verify'&&Object.keys(flags).every(k=>k==='--runtime'))return verifyPilotManifest(flags['--runtime']??fileURLToPath(new URL('../../',import.meta.url)));
 if((command==='preflight'||command==='adopt')&&flags['--workspace']&&flags['--backup']&&flags['--owner']&&Object.keys(flags).every(k=>['--workspace','--backup','--owner',...(command==='adopt'?['--receipt']:[])].includes(k))){
  const input={workspace:flags['--workspace'],backup:flags['--backup'],owner:flags['--owner']};
  if(command==='preflight')return migrationPreflight(input);
  if(flags['--receipt'])return adoptMigration(input,flags['--receipt']);
 }
 throw Error('PILOT_USAGE_INVALID');
}
try{const result=await main();console.log(JSON.stringify(result,null,2));if('integrity'in result&&result.integrity!=='matched')process.exitCode=1;}
catch(error){console.error(JSON.stringify({kind:'pilot-error',code:error instanceof Error&&/^[A-Z_]+$/.test(error.message)?error.message:'PILOT_CHECK_FAILED',help:'doctor | verify [--runtime PATH] | preflight --workspace PATH --backup JSON --owner ID | adopt with the same arguments and --receipt DIGEST. Close the original owner first. No credentials are accepted on the command line.'}));process.exitCode=1;}
