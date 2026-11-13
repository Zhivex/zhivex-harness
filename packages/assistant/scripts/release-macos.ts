import {readFile} from 'node:fs/promises';
import {inspectRelease,packageMacRelease} from '../src/release/package-macos.js';

const [mode,configPath,...extra]=process.argv.slice(2);
if(!['inspect','package'].includes(mode??'')||!configPath||extra.length) {
 console.error('Usage: bun scripts/release-macos.ts inspect|package CONFIG.json');process.exit(2);
}
try {
 const value=JSON.parse(await readFile(configPath,'utf8'));
 if(mode==='inspect') {
  const {config,binaries,identityPresent}=await inspectRelease(value);
  console.log(JSON.stringify({version:config.version,teamId:config.teamId,output:config.outputDirectory,
   nativeFiles:binaries.length,identityPresent,willUploadToApple:false,readyToSign:identityPresent},null,2));
 } else console.log(JSON.stringify(await packageMacRelease(value),null,2));
} catch(error) {console.error(error instanceof Error?error.message:'RELEASE_FAILED');process.exitCode=1;}
