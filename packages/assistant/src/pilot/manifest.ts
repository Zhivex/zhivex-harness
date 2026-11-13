import {createHash} from 'node:crypto';
import {lstat,readdir,readFile,readlink,realpath,writeFile} from 'node:fs/promises';
import path from 'node:path';
import {z} from 'zod';
const name=z.string().min(1).max(2048).refine(s=>!path.isAbsolute(s)&&!s.includes('\\')&&s.split('/').every(p=>p&&p!=='.'&&p!=='..'));
const schema=z.object({schemaVersion:z.literal(1),channel:z.literal('local-pilot'),platform:z.literal('darwin'),architecture:z.literal('arm64'),createdAt:z.string(),engineVersion:z.string(),nodeVersion:z.string(),files:z.array(z.object({path:name,type:z.enum(['file','symlink']),sha256:z.string().length(64)}).strict()).min(1).max(20000)}).strict();
const digest=(data:string|Buffer)=>createHash('sha256').update(data).digest('hex');
async function inventory(root:string){
 const canonical=await realpath(root),files:z.infer<typeof schema>['files']=[];let bytes=0;
 async function visit(relative:string){
  for(const entry of await readdir(path.join(canonical,relative),{withFileTypes:true})){
   const file=relative?relative+'/'+entry.name:entry.name;if(file==='pilot-manifest.json')continue;name.parse(file);
   const full=path.join(canonical,file),stat=await lstat(full);
   if(stat.isSymbolicLink()){
    const target=await realpath(full);if(!target.startsWith(canonical+path.sep))throw Error('PILOT_EXTERNAL_SYMLINK');
    files.push({path:file,type:'symlink',sha256:digest(await readlink(full))});
   }else if(stat.isDirectory())await visit(file);
   else if(stat.isFile()){
    bytes+=stat.size;if(stat.size>256*1024*1024||bytes>1024*1024*1024)throw Error('PILOT_RUNTIME_TOO_LARGE');
    files.push({path:file,type:'file',sha256:digest(await readFile(full))});
   }else throw Error('PILOT_RUNTIME_FILE_INVALID');
   if(files.length>20000)throw Error('PILOT_RUNTIME_TOO_LARGE');
  }
 }
 await visit('');return files.sort((a,b)=>a.path.localeCompare(b.path));
}
/** Reproducible integrity evidence, not a signing or update-trust mechanism. */
export async function writePilotManifest(root:string,nodeVersion=process.versions.node){
 if(process.platform!=='darwin'||process.arch!=='arm64')throw Error('PILOT_PLATFORM_UNSUPPORTED');
 const engine=JSON.parse(await readFile(path.join(root,'node_modules/@zhivex-ai/harness/package.json'),'utf8'));
 const manifest=schema.parse({schemaVersion:1,channel:'local-pilot',platform:process.platform,architecture:process.arch,createdAt:new Date().toISOString(),engineVersion:engine.version,nodeVersion,files:await inventory(root)});
 await writeFile(path.join(root,'pilot-manifest.json'),JSON.stringify(manifest,null,2)+'\n');return manifest;
}
export async function verifyPilotManifest(root:string){
 const stat=await lstat(path.join(root,'pilot-manifest.json'));if(!stat.isFile()||stat.isSymbolicLink()||stat.size>8*1024*1024)throw Error('PILOT_MANIFEST_INVALID');
 const manifest=schema.parse(JSON.parse(await readFile(path.join(root,'pilot-manifest.json'),'utf8'))),actual=await inventory(root);
 const expected=new Map(manifest.files.map(f=>[f.path,f]));if(expected.size!==manifest.files.length)throw Error('PILOT_MANIFEST_INVALID');
 const mismatches:string[]=[];
 for(const file of actual){const saved=expected.get(file.path);if(!saved||saved.type!==file.type||saved.sha256!==file.sha256)mismatches.push(file.path);expected.delete(file.path);}
 mismatches.push(...expected.keys());
 return{channel:manifest.channel,integrity:mismatches.length?'mismatch':'matched',mismatches,files:actual.length,engineVersion:manifest.engineVersion,platform:manifest.platform,architecture:manifest.architecture,platformMatches:process.platform===manifest.platform&&process.arch===manifest.architecture,productionReady:false,trust:'Requires separate signing, notarization and update verification; a matching manifest is not authentication.'};
}
