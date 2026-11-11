import { spawn } from 'node:child_process';
import { homedir } from 'node:os';
import path from 'node:path';
import { open, rename, unlink } from 'node:fs/promises';
import { constants } from 'node:fs';
import { startManagedAssistant } from './setup.js';

export function openBrowser(url: string) {
  const command = process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'explorer.exe' : 'xdg-open';
  const child = spawn(command, [url], { stdio: 'ignore', detached: true }); child.on('error', () => {}); child.unref();
}
export async function launchAssistant(args: string[]) {
  let directory = path.join(homedir(), '.zhx-app'), port = 0;
  for (let i=0;i<args.length;i++) {
    const flag=args[i];
    if (flag === '--setup' || flag === '--open') continue;
    if (flag === '--directory' && args[i+1]) { directory=path.resolve(args[++i]!); continue; }
    if (flag === '--web-port' && /^\d{1,5}$/.test(args[i+1] ?? '') && Number(args[i+1]) <= 65535) {port=Number(args[++i]);continue;}
    throw new Error('ASSISTANT_USAGE_INVALID');
  }
  const accessPath=path.join(directory,'web-access.json');
  let managed: Awaited<ReturnType<typeof startManagedAssistant>>;
  try { managed = await startManagedAssistant(directory,{port,onStop:()=>stop()}); }
  catch(error) {
    if (!(error instanceof Error) || error.message !== 'SETUP_ALREADY_RUNNING') throw error;
    const file=await open(accessPath,constants.O_RDONLY|constants.O_NOFOLLOW);
    let url: URL;
    try {const s=await file.stat();if(!s.isFile() || s.size>4096 || s.uid!==process.getuid?.() || (s.mode&0o077))throw new Error('SETUP_ACCESS_UNSAFE');url=new URL(JSON.parse(await file.readFile('utf8')).url);}finally{await file.close();}
    if(url.protocol!=='http:' || url.hostname!=='127.0.0.1' || url.username || url.password)throw new Error('SETUP_ACCESS_UNSAFE');
    const token=new URLSearchParams(url.hash.slice(1)).get('token');
    const response=await fetch(url.origin+'/api/setup',{headers:{authorization:`Bearer ${token}`},signal:AbortSignal.timeout(3000),redirect:'error'});
    if(!response.ok)throw new Error('SETUP_ALREADY_RUNNING');openBrowser(url.href);return;
  }
  const temporary=accessPath+'.'+process.pid;
  try {const file=await open(temporary,'wx',0o600);try{await file.writeFile(JSON.stringify({url:managed.url}));await file.sync();}finally{await file.close();}await rename(temporary,accessPath);}
  catch(error){await managed.close();throw error;}
  openBrowser(managed.url);
  // The launcher opens the credential-bearing URL directly. Do not print it into GUI logs.
  console.log(JSON.stringify({kind:'assistant-web-opened'}));
  let stopping=false;
  const stop=()=>{if(stopping)return;stopping=true;void managed.close().then(()=>unlink(accessPath)).catch(()=>{process.exitCode=1;});};
  process.once('SIGINT',stop);process.once('SIGTERM',stop);
}
