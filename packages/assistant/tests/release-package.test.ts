import {expect,test} from 'bun:test';
import {appendFile,chmod,mkdir,mkdtemp,readFile,rm,writeFile} from 'node:fs/promises';
import {createHash,generateKeyPairSync} from 'node:crypto';
import path from 'node:path';
import {inspectRelease,nativeFiles,packageMacRelease} from '../src/release/package-macos.js';
import {createMacApplicationVerifier,PRODUCT,EXECUTABLE,type Command} from '../src/release/mac-application-verifier.js';
import {writePilotManifest,verifyPilotManifest} from '../src/pilot/manifest.js';
import {signReleaseManifest} from '../src/release/publish-manifest.js';
import {verifyUpdateManifest,type UpdateManifest} from '../src/release/update-manifest.js';

// Bundle manifests deliberately reject unsupported hosts. CI runs these
// contracts in its macOS arm64 job, including the simulated signing commands.
const macTest = test.skipIf(process.platform !== 'darwin' || process.arch !== 'arm64');

async function fixture(run:(f:{root:string;app:string;config:ReturnType<typeof config>;calls:string[][];command:Command})=>Promise<void>){
 const root=await mkdtemp('/tmp/assistant-release-'),app=path.join(root,'Source.app');
 const runtime=path.join(app,'Contents/Resources/runtime');
 await mkdir(path.join(runtime,'node_modules/@zhivex-ai/harness'),{recursive:true});
 await mkdir(path.join(app,'Contents/MacOS'),{recursive:true});
 await writeFile(path.join(runtime,'node_modules/@zhivex-ai/harness/package.json'),'{"version":"1.6.3"}');
 for(const file of [path.join(runtime,'node'),path.join(runtime,'binding.node'),path.join(app,'Contents/MacOS',EXECUTABLE)])await writeFile(file,Buffer.from('cffaedfe00000000','hex'));
 const plist={CFBundleIdentifier:PRODUCT,CFBundleExecutable:EXECUTABLE,CFBundleShortVersionString:'0.2.0',CFBundleVersion:'0.2.0'};
 await writeFile(path.join(app,'Contents/Info.plist'),JSON.stringify(plist));await writePilotManifest(runtime,'24.11.0');
 const calls:string[][]=[];
 const command:Command=async(binary,args)=>{
  calls.push([binary,...args]);
  if(binary.endsWith('plutil'))return {stdout:await readFile(args.at(-1)!,'utf8'),stderr:''};
  if(binary.endsWith('security'))return {stdout:`1) ${'A'.repeat(40)} "Developer ID Application: Fixture (ABCDEFGHIJ)"`,stderr:''};
  if(binary.endsWith('lipo'))return {stdout:'arm64',stderr:''};
  if(binary.endsWith('spctl'))return {stdout:'',stderr:'source=Notarized Developer ID'};
  if(args.includes('--display'))return {stdout:'',stderr:'CodeDirectory v=20500 flags=0x10000(runtime)'};
  if(args.includes('--sign')&&!args.at(-1)!.endsWith('.app')&&!args.at(-1)!.endsWith('.dmg'))await appendFile(args.at(-1)!,'fixture signature');
  if(args[0]==='notarytool')return {stdout:'{"status":"Accepted","id":"fixture"}',stderr:''};
  return {stdout:'',stderr:''};
 };
 try{await run({root,app,config:config(root,app),calls,command});}finally{await rm(root,{recursive:true,force:true});}
}
function config(root:string,app:string){return {application:app,outputDirectory:path.join(root,'release'),version:'0.2.0',teamId:'ABCDEFGHIJ',signingIdentity:'A'.repeat(40),notaryProfile:'fixture'};}

macTest('release signs every native module before inventory and outer seal, notarizes, staples and assesses',()=>fixture(async f=>{
 const before=await readFile(path.join(f.app,'Contents/Resources/runtime/node'));
 expect((await nativeFiles(f.app)).length).toBe(3);
 const result=await packageMacRelease(f.config,f.command);
 expect((await verifyPilotManifest(path.join(result.application,'Contents/Resources/runtime'))).integrity).toBe('matched');
 expect(await readFile(path.join(f.app,'Contents/Resources/runtime/node'))).toEqual(before);
 const signs=f.calls.filter(c=>c.includes('--sign'));expect(signs.length).toBe(5);
 expect(signs[3]!.at(-1)).toBe(result.application);
 expect(signs.filter(c=>c.includes('--entitlements')).length).toBe(1);
 expect(f.calls.filter(c=>c[1]==='notarytool').length).toBe(2);
 await expect(packageMacRelease(f.config,f.command)).rejects.toThrow();
}));
macTest('missing certificate, rejected notarization and altered bundle fail closed',()=>fixture(async f=>{
 const missing:Command=async(b,a)=>b.endsWith('security')?{stdout:'0 valid identities found',stderr:''}:f.command(b,a);
 expect((await inspectRelease(f.config,missing)).identityPresent).toBe(false);
 await expect(packageMacRelease(f.config,missing)).rejects.toThrow('RELEASE_DEVELOPER_ID_MISSING');
 const rejected:Command=async(b,a)=>a[0]==='notarytool'?{stdout:'{"status":"Invalid"}',stderr:''}:f.command(b,a);
 await expect(packageMacRelease(f.config,rejected)).rejects.toThrow('RELEASE_NOTARIZATION_REJECTED');
 expect(f.calls.some(c=>c[1]==='stapler')).toBe(false);
 await appendFile(path.join(f.app,'Contents/Resources/runtime/node'),'tamper');
 await expect(inspectRelease(f.config,f.command)).rejects.toThrow('RELEASE_INTEGRITY_FAILED');
}));
macTest('native verifier rejects signature, version, architecture, hardened runtime and Gatekeeper overrides',()=>fixture(async f=>{
 for(const failure of ['signature','version','architecture','runtime','gatekeeper']){
  const command:Command=async(b,a)=>{
   if(failure==='signature'&&a.includes('--verify'))throw Error('fixture failure');
   if(failure==='version'&&b.endsWith('plutil'))return {stdout:'{}',stderr:''};
   if(failure==='architecture'&&b.endsWith('lipo'))return {stdout:'x86_64',stderr:''};
   if(failure==='runtime'&&a.includes('--display'))return {stdout:'',stderr:'CodeDirectory flags=0x2(adhoc)'};
   if(failure==='gatekeeper'&&b.endsWith('spctl'))return {stdout:'',stderr:'source=User ID'};
   return f.command(b,a);
  };
  await expect(createMacApplicationVerifier(command)(f.app,{teamId:'ABCDEFGHIJ',version:'0.2.0'})).rejects.toThrow('UPDATE_APPLICATION_REJECTED');
 }
}));
test('offline publisher signs exact artifact metadata and refuses public key permissions or altered bytes',async()=>{
 const root=await mkdtemp('/tmp/assistant-publisher-');
 try{
  const keys=generateKeyPairSync('ed25519'),file=path.join(root,'key.pem'),artifact=path.join(root,'fixture.dmg');
  await writeFile(file,keys.privateKey.export({type:'pkcs8',format:'pem'}),{mode:0o600});await writeFile(artifact,'fixture');
  const manifest:UpdateManifest={schemaVersion:1,product:PRODUCT,platform:'darwin',arch:'arm64',version:'0.2.0',channel:'stable',publishedAt:Date.now(),expiresAt:Date.now()+60_000,state:{minReadable:1,maxReadable:1},artifact:{url:'https://github.com/Zhivex/zhivex-harness/releases/download/assistant-v0.2.0/fixture.dmg',size:7,sha256:createHash('sha256').update('fixture').digest('hex')}};
  const input={artifact,privateKeyFile:file,manifest,currentVersion:'0.1.0',stateSchema:1};
  const envelope=await signReleaseManifest(input);
  expect(verifyUpdateManifest(envelope,{publicKey:keys.publicKey,currentVersion:'0.1.0',stateSchema:1,channel:'stable'}).version).toBe('0.2.0');
  await chmod(file,0o644);await expect(signReleaseManifest(input)).rejects.toThrow('RELEASE_KEY_PERMISSIONS');
  await chmod(file,0o600);await appendFile(artifact,'tamper');await expect(signReleaseManifest(input)).rejects.toThrow('RELEASE_ARTIFACT_MISMATCH');
 }finally{await rm(root,{recursive:true,force:true});}
});
