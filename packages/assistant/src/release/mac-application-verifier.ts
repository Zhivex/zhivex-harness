import {execFile} from 'node:child_process';
import {lstat, realpath} from 'node:fs/promises';
import path from 'node:path';
import {compareUpdateVersions} from './update-manifest.js';
import {verifyPilotManifest} from '../pilot/manifest.js';

export const PRODUCT = 'ai.zhivex.assistant.preview';
export const EXECUTABLE = 'zhivex-assistant-desktop';
export type Command = (binary: string, args: string[]) => Promise<{stdout: string; stderr: string}>;
export const nativeCommand: Command = (binary, args) => new Promise((resolve, reject) => {
 execFile(binary, args, {encoding:'utf8', timeout:args[0]==='notarytool'?22*60_000:120_000, maxBuffer:1024*1024,
  env:{PATH:'/usr/bin:/bin:/usr/sbin:/sbin',LANG:'C',LC_ALL:'C'}}, (error, stdout, stderr) => {
  if(error) reject(new Error('RELEASE_COMMAND_FAILED')); else resolve({stdout,stderr});
 });
});
export function developerRequirement(team: string, identifier?: string) {
 if(!/^[A-Z0-9]{10}$/.test(team)) throw Error('UPDATE_PUBLISHER_NOT_CONFIGURED');
 return `${identifier ? `identifier "${identifier}" and ` : ''}anchor apple generic and certificate 1[field.1.2.840.113635.100.6.2.6] exists and certificate leaf[field.1.2.840.113635.100.6.1.13] exists and certificate leaf[subject.OU] = "${team}"`;
}
/** Adapted from Desktop: OS-enforced publisher identity, exact Tauri version, runtime and notarization. */
export function createMacApplicationVerifier(command: Command = nativeCommand, platform = process.platform,
 integrity = verifyPilotManifest) {
 return async (requested:string, policy:{teamId:string;version:string}) => {
  if(platform!=='darwin') throw Error('UPDATE_PUBLISHER_NOT_CONFIGURED');
  const requirement=developerRequirement(policy.teamId,PRODUCT);
  try {
   compareUpdateVersions(policy.version,policy.version);
   if(!path.isAbsolute(requested)||!requested.endsWith('.app')) throw Error();
   const stat=await lstat(requested); if(!stat.isDirectory()||stat.isSymbolicLink()) throw Error();
   const app=await realpath(requested);
   await command('/usr/bin/codesign',['--verify','--deep','--strict','--all-architectures','-R',requirement,app]);
   const plist=JSON.parse((await command('/usr/bin/plutil',['-convert','json','-o','-',path.join(app,'Contents/Info.plist')])).stdout);
   if(plist.CFBundleIdentifier!==PRODUCT||plist.CFBundleExecutable!==EXECUTABLE||
      plist.CFBundleShortVersionString!==policy.version||plist.CFBundleVersion!==policy.version) throw Error();
   for(const binary of [path.join(app,'Contents/MacOS',EXECUTABLE),path.join(app,'Contents/Resources/runtime/node')]) {
    const info=await lstat(binary);if(!info.isFile()||info.isSymbolicLink()) throw Error();
    await command('/usr/bin/codesign',['--verify','--strict','-R',developerRequirement(policy.teamId),binary]);
    if((await command('/usr/bin/lipo',['-archs',binary])).stdout.trim()!=='arm64') throw Error();
    const detail=await command('/usr/bin/codesign',['--display','--verbose=4',binary]);
    if(!/^CodeDirectory .*flags=0x[0-9a-f]+\([^\n)]*\bruntime\b[^\n)]*\)/im.test(detail.stderr+detail.stdout)) throw Error();
   }
   if((await integrity(path.join(app,'Contents/Resources/runtime'))).integrity!=='matched') throw Error();
   const assessment=await command('/usr/sbin/spctl',['--assess','--type','execute','--verbose=4','--ignore-cache','--no-cache',app]);
   const origins=(assessment.stdout+'\n'+assessment.stderr).split(/\r?\n/).filter(s=>s.startsWith('source='));
   if(origins.length!==1||origins[0]!.trim()!=='source=Notarized Developer ID') throw Error();
   return Object.freeze({application:app,version:policy.version,teamId:policy.teamId,notarized:true as const});
  } catch {throw Error('UPDATE_APPLICATION_REJECTED');}
 };
}
