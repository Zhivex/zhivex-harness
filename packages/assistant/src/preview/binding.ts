import {writeFile} from 'node:fs/promises';
import path from 'node:path';
import {readRegularFileNoFollow} from '../delivery/file-security.js';

/** Keep pre-stage-6 run fingerprints intact. Only newly initialized local runtimes get the browser tool. */
export async function previewToolsEnabled(directory:string,local:boolean):Promise<boolean>{
  if(!local)return false;
  const marker=path.join(directory,'preview-tools.binding');
  try{
    const {contents}=await readRegularFileNoFollow(marker,{label:'Preview tool binding',maxBytes:32,requireSingleLink:true});
    if(contents.toString()!=='preview-v1')throw Error('PREVIEW_BINDING_INVALID');return true;
  }catch(error){if((error as NodeJS.ErrnoException).code!=='ENOENT')throw error;}
  try{
    await readRegularFileNoFollow(path.join(directory,'runtime.binding'),{label:'Runtime binding',maxBytes:128,requireSingleLink:true});return false;
  }catch(error){if((error as NodeJS.ErrnoException).code!=='ENOENT')throw error;}
  await writeFile(marker,'preview-v1',{flag:'wx',mode:0o600});return true;
}
