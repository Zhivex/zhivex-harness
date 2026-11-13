import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {createHash} from 'node:crypto';
import path from 'node:path';
import {readRegularFileNoFollow} from '../delivery/file-security.js';
const exec=promisify(execFile);
/** Content identity, including dirty and nonignored new files. Failure is unknown, never fresh. */
export async function sourceRevision(root:string):Promise<{head:string;digest:string}|null>{
  try{
    const git=(args:string[])=>exec('git',['-c','core.fsmonitor=false','-c','core.hooksPath=/dev/null','-C',root,...args],{timeout:5000,maxBuffer:1024*1024,env:{PATH:process.env.PATH??'/usr/bin:/bin',GIT_CONFIG_NOSYSTEM:'1',GIT_CONFIG_GLOBAL:'/dev/null',GIT_TERMINAL_PROMPT:'0'}});
    const head=(await git(['rev-parse','--verify','HEAD']).catch(()=>({stdout:'unborn'}))).stdout.trim();
    const names=[...new Set((await git(['ls-files','-z','--cached','--others','--exclude-standard'])).stdout.split('\0').filter(Boolean))].sort();
    if(names.length>4096)return null;
    const digest=createHash('sha256').update(head);let total=0;
    for(const name of names){
      if(name==='\.zhivex-harness'||name.startsWith('.zhivex-harness/'))continue;
      if(path.isAbsolute(name)||name.split('/').includes('..'))return null;
      digest.update(JSON.stringify(name));
      try{
        const {contents}=await readRegularFileNoFollow(path.join(root,name),{label:'Source revision',maxBytes:2*1024*1024,requireSingleLink:true});
        total+=contents.length;if(total>32*1024*1024)return null;digest.update(createHash('sha256').update(contents).digest());
      }catch(error){if((error as NodeJS.ErrnoException).code==='ENOENT')digest.update('deleted');else return null;}
    }
    return{head,digest:digest.digest('hex')};
  }catch{return null;}
}
