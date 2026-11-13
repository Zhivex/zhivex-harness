import {readFile,writeFile} from 'node:fs/promises';
import {signReleaseManifest} from '../src/release/publish-manifest.js';

const [descriptor,privateKeyFile,artifact,output,...extra]=process.argv.slice(2);
if(!descriptor||!privateKeyFile||!artifact||!output||extra.length){
 console.error('Usage: bun scripts/sign-update-manifest.ts DESCRIPTOR.json PRIVATE_KEY.pem ARTIFACT.dmg OUTPUT.json');process.exit(2);
}
try{
 const {manifest,currentVersion,stateSchema}=JSON.parse(await readFile(descriptor,'utf8'));
 const envelope=await signReleaseManifest({manifest,currentVersion,stateSchema,privateKeyFile,artifact});
 await writeFile(output,envelope,{flag:'wx',mode:0o600});console.log('Signed update envelope written. Nothing published.');
}catch{console.error('RELEASE_MANIFEST_SIGNING_FAILED');process.exitCode=1;}
