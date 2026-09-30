import { createHash } from 'node:crypto';
import { lstat,readdir } from 'node:fs/promises';
import path from 'node:path';
import { readRegularFileNoFollow } from '../workspace/file-security.js';

/** Verification identity includes ignored/hidden files too; never exposes their contents. */
export async function acceptanceSnapshotDigest(root:string,maxBytes:number):Promise<string> {
  const rows:Array<[string,'file'|'directory',number,string|null]>=[];
  let bytes=0;
  async function visit(relative:string):Promise<void> {
    const names=await readdir(path.join(root,relative));
    names.sort();
    for(const name of names) {
      const item=relative?relative+'/'+name:name;
      if(rows.length>=20_000)throw new Error('TASK_ACCEPTANCE_SNAPSHOT_CAPACITY');
      const absolute=path.join(root,item),entry=await lstat(absolute);
      if(entry.isSymbolicLink())throw new Error('TASK_ACCEPTANCE_SNAPSHOT_UNSAFE');
      if(entry.isDirectory()) {
        rows.push([item,'directory',entry.mode&0o777,null]);await visit(item);
      } else if(entry.isFile() && entry.nlink===1) {
        const file=await readRegularFileNoFollow(absolute,{label:'Acceptance snapshot file',maxBytes:maxBytes-bytes,requireSingleLink:true});
        bytes+=file.contents.byteLength;
        rows.push([item,'file',file.stat.mode&0o777,createHash('sha256').update(file.contents).digest('hex')]);
      } else throw new Error('TASK_ACCEPTANCE_SNAPSHOT_UNSAFE');
    }
  }
  await visit('');
  return 'sha256:'+createHash('sha256').update(JSON.stringify(rows)).digest('hex');
}
