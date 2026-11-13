import { syncPrivateDirectory } from '../private-directory.js';
import {createHash,randomUUID} from 'node:crypto';
import {lstat,mkdir,open} from 'node:fs/promises';
import path from 'node:path';
import {resolveHarnessConfig,stateBackupBundleSchema,importHarnessStateBackup} from '@zhivex-ai/harness/engine';
import {canonicalProject,acquireAssistantProjectOwner,ensureProjectPrivateDirectory} from '../projects.js';
import {readRegularFileNoFollow} from '../delivery/file-security.js';
import {z} from 'zod';
const inputSchema=z.object({workspace:z.string().min(1),backup:z.string().min(1),owner:z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/)}).strict();
export type MigrationInput=z.infer<typeof inputSchema>;
async function prepare(input:MigrationInput){
 const value=inputSchema.parse(input),project=await canonicalProject(value.workspace),stateDirectory=path.join(project.canonicalPath,'.zhivex-harness','assistant');
 const source=await readRegularFileNoFollow(path.resolve(value.backup),{label:'Migration backup',maxBytes:64*1024*1024,requireSingleLink:true});
 if(source.stat.uid!==process.getuid?.()||(source.stat.mode&0o077))throw Error('MIGRATION_BACKUP_NOT_PRIVATE');
 const bundle=stateBackupBundleSchema.parse(JSON.parse(source.contents.toString())),config=resolveHarnessConfig({workspace:project.canonicalPath,stateDirectory,tenantId:'assistant-local',userId:value.owner,namespace:'assistant-coding-v1',storeBackend:'sqlite'});
 return{value,project,stateDirectory,bundle,config,source,receipt:createHash('sha256').update(source.contents).update(JSON.stringify({workspace:project.canonicalPath,owner:value.owner,stateDirectory})).digest('hex')};
}
/** Uses the same validated backup/import contract as Code. No scope rewriting or credential copying. */
export async function migrationPreflight(input:MigrationInput){
 const p=await prepare(input);let compatible=false;
 try{await importHarnessStateBackup(p.config,p.bundle,{dryRun:true});compatible=true;}catch{/* Preserve incompatible history under the original owner. */}
 let targetEmpty=false;try{await lstat(p.stateDirectory);}catch(e){if((e as NodeJS.ErrnoException).code==='ENOENT')targetEmpty=true;else throw e;}
 return{schemaVersion:1,kind:'migration-preflight',receipt:p.receipt,compatible,targetEmpty,canAdopt:compatible&&targetEmpty,workspace:p.project.canonicalPath,checksum:p.bundle.checksum,counts:Object.fromEntries(Object.entries(p.bundle.records).map(([key,rows])=>[key,rows?.length??0])),credentials:{copied:false,action:'Reconnect the provider in Assistant. Keep the original Code/Desktop keychain references and host directory unchanged.'},action:!compatible?'Keep history in Code/Desktop. Finish or reconcile pending work there; do not rewrite workspace or scope identities.':!targetEmpty?'Target already exists. Use the original owner for recovery; this pilot never merges or overwrites an existing store.':'Compatible terminal history may be adopted into an empty target after closing the original owner.',compatibilityCommand:'zhivex-code'};
}
async function durableWrite(filename:string,contents:string|Buffer){const file=await open(filename,'wx',0o600);try{await file.writeFile(contents);await file.sync();}finally{await file.close();}}
export async function adoptMigration(input:MigrationInput,receipt:string){
 const before=await migrationPreflight(input);if(!before.canAdopt||before.receipt!==receipt)throw Error('MIGRATION_PREFLIGHT_CHANGED');
 const p=await prepare(input);if(p.receipt!==receipt)throw Error('MIGRATION_PREFLIGHT_CHANGED');
 const release=await acquireAssistantProjectOwner(p.project.canonicalPath,false);
 try{
  // Exclusive mkdir refuses a target created since review. No overwrite, merge or rollback deletion.
  await mkdir(p.stateDirectory,{mode:0o700});
  const archive=await ensureProjectPrivateDirectory(path.join(path.dirname(p.stateDirectory),'migration-'+randomUUID()));
  await durableWrite(path.join(archive,'source-backup.json'),p.source.contents);
  await durableWrite(path.join(archive,'receipt.json'),JSON.stringify({schemaVersion:1,receipt,checksum:p.bundle.checksum,createdAt:new Date().toISOString(),sourceUnchanged:true,credentialsCopied:false}));
  await syncPrivateDirectory(archive,'MIGRATION_ARCHIVE_UNSAFE');
  await syncPrivateDirectory(path.dirname(archive),'MIGRATION_ARCHIVE_UNSAFE');
  try{const result=await importHarnessStateBackup(p.config,p.bundle,{dryRun:false});return{kind:'migration-adopted',archive,receipt,result,credentialsCopied:false};}
  catch{throw Error('MIGRATION_IMPORT_FAILED_PRESERVED');}
 }finally{await release();}
}
