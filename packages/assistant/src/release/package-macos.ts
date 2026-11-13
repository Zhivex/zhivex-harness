import {cp,lstat,mkdir,open,readdir,readFile,realpath,writeFile} from 'node:fs/promises';
import path from 'node:path';
import {z} from 'zod';
import {writePilotManifest,verifyPilotManifest} from '../pilot/manifest.js';
import {createMacApplicationVerifier,developerRequirement,EXECUTABLE,nativeCommand,PRODUCT,type Command} from './mac-application-verifier.js';

export const releaseConfigSchema=z.object({
 application:z.string().min(1), outputDirectory:z.string().min(1),
 version:z.string().regex(/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/),
 teamId:z.string().regex(/^[A-Z0-9]{10}$/),
 signingIdentity:z.string().regex(/^[A-Fa-f0-9]{40}$/),
 notaryProfile:z.string().regex(/^[A-Za-z0-9._-]{1,128}$/),
}).strict();
export type ReleaseConfig=z.infer<typeof releaseConfigSchema>;

/** Discover Mach-O by magic, including native Node modules without executable permission. */
export async function nativeFiles(root:string):Promise<string[]> {
 const canonical=await realpath(root),files:string[]=[];let entries=0;
 async function visit(file:string):Promise<void>{
  if(++entries>50000) throw Error('RELEASE_TREE_TOO_LARGE');
  const stat=await lstat(file);
  if(stat.isSymbolicLink()) {
   if(!(await realpath(file)).startsWith(canonical+path.sep)) throw Error('RELEASE_EXTERNAL_SYMLINK');
  } else if(stat.isDirectory()) {for(const name of await readdir(file))await visit(path.join(file,name));}
  else if(stat.isFile()) {
   const fd=await open(file,'r');const magic=Buffer.alloc(4);
   try{await fd.read(magic,0,4,0);}finally{await fd.close();}
   if(['feedface','cefaedfe','feedfacf','cffaedfe','cafebabe','bebafeca','cafebabf','bfbafeca'].includes(magic.toString('hex'))) files.push(file);
  } else throw Error('RELEASE_SPECIAL_FILE');
 }
 await visit(canonical);return files.sort((a,b)=>b.split(path.sep).length-a.split(path.sep).length||a.localeCompare(b));
}
export async function inspectRelease(value:unknown,command:Command=nativeCommand){
 const config=releaseConfigSchema.parse(value);
 if(process.platform!=='darwin'||process.arch!=='arm64')throw Error('RELEASE_PLATFORM_UNSUPPORTED');
 const application=path.resolve(config.application);
 const requestedOutput=path.resolve(config.outputDirectory);
 const outputDirectory=path.join(await realpath(path.dirname(requestedOutput)),path.basename(requestedOutput));
 const stat=await lstat(application);
 if(!stat.isDirectory()||stat.isSymbolicLink()||!application.endsWith('.app'))throw Error('RELEASE_BUNDLE_INVALID');
 const source=await realpath(application);
 if(outputDirectory===source||outputDirectory.startsWith(source+path.sep))throw Error('RELEASE_OUTPUT_OVERLAP');
 const plist=JSON.parse((await command('/usr/bin/plutil',['-convert','json','-o','-',path.join(source,'Contents/Info.plist')])).stdout);
 if(plist.CFBundleIdentifier!==PRODUCT||plist.CFBundleExecutable!==EXECUTABLE||plist.CFBundleShortVersionString!==config.version||plist.CFBundleVersion!==config.version)throw Error('RELEASE_IDENTITY_MISMATCH');
 const runtime=path.join(source,'Contents/Resources/runtime');
 if((await verifyPilotManifest(runtime)).integrity!=='matched')throw Error('RELEASE_INTEGRITY_FAILED');
 const binaries=await nativeFiles(source);
 const identities=await command('/usr/bin/security',['find-identity','-v','-p','codesigning']);
 const identityPresent=identities.stdout.split('\n').some(line=>line.toUpperCase().includes(config.signingIdentity.toUpperCase())&&line.includes('Developer ID Application:')&&line.includes(`(${config.teamId})`));
 return {config:{...config,application:source,outputDirectory},binaries,identityPresent};
}

/** Operates only on a new output directory. Does not publish, install, launch, or modify source/state. */
export async function packageMacRelease(value:unknown,command:Command=nativeCommand){
 const inspected=await inspectRelease(value,command),{config}=inspected;
 if(!inspected.identityPresent)throw Error('RELEASE_DEVELOPER_ID_MISSING');
 // Exclusive creation prevents overwriting prior release evidence.
 await mkdir(config.outputDirectory,{mode:0o700});
 const app=path.join(config.outputDirectory,'Zhivex Assistant.app');
 await cp(config.application,app,{recursive:true,verbatimSymlinks:true,force:false,errorOnExist:true});
 const entitlements=path.join(config.outputDirectory,'node-entitlements.plist');
 await writeFile(entitlements,'<?xml version="1.0" encoding="UTF-8"?><!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd"><plist version="1.0"><dict><key>com.apple.security.cs.allow-jit</key><true/></dict></plist>',{flag:'wx',mode:0o600});
 const runtime=path.join(app,'Contents/Resources/runtime');
 const previous=JSON.parse(await readFile(path.join(runtime,'pilot-manifest.json'),'utf8'));
 for(const binary of await nativeFiles(app)) {
  await command('/usr/bin/codesign',['--force','--sign',config.signingIdentity,'--timestamp','--options','runtime',
   ...(binary===path.join(runtime,'node')?['--entitlements',entitlements]:[]),binary]);
  await command('/usr/bin/codesign',['--verify','--strict','-R',developerRequirement(config.teamId),binary]);
 }
 // Nested signing changes bytes. Inventory must be regenerated before sealing the outer bundle.
 await writePilotManifest(runtime,previous.nodeVersion);
 await command('/usr/bin/codesign',['--force','--sign',config.signingIdentity,'--timestamp','--options','runtime',app]);
 await command('/usr/bin/codesign',['--verify','--deep','--strict','-R',developerRequirement(config.teamId,PRODUCT),app]);
 const zip=path.join(config.outputDirectory,'notarization.zip');
 await command('/usr/bin/ditto',['-c','-k','--keepParent',app,zip]);
 async function notarize(file:string){
  const receipt=JSON.parse((await command('/usr/bin/xcrun',['notarytool','submit',file,'--keychain-profile',config.notaryProfile,'--wait','--timeout','20m','--output-format','json'])).stdout);
  await writeFile(file+'.notary.json',JSON.stringify({id:receipt.id,status:receipt.status},null,2)+'\n',{flag:'wx',mode:0o600});
  if(receipt.status!=='Accepted')throw Error('RELEASE_NOTARIZATION_REJECTED');
 }
 await notarize(zip);
 await command('/usr/bin/xcrun',['stapler','staple',app]);
 await command('/usr/bin/xcrun',['stapler','validate',app]);
 await createMacApplicationVerifier(command)(app,{teamId:config.teamId,version:config.version});
 const dmg=path.join(config.outputDirectory,`Zhivex-Assistant-${config.version}-arm64.dmg`);
 await command('/usr/bin/hdiutil',['create','-volname','Zhivex Assistant','-srcfolder',app,'-format','UDZO',dmg]);
 await command('/usr/bin/codesign',['--sign',config.signingIdentity,'--timestamp',dmg]);
 await notarize(dmg);await command('/usr/bin/xcrun',['stapler','staple',dmg]);await command('/usr/bin/xcrun',['stapler','validate',dmg]);
 return {application:app,artifact:dmg,version:config.version,teamId:config.teamId};
}
