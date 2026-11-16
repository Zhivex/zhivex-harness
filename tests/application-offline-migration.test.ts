import {expect, test} from 'bun:test';
import {chmod, mkdtemp, mkdir, writeFile, readFile, readdir, realpath, rm, symlink} from 'node:fs/promises';
import {applicationMigration} from '../packages/core/src/application/offline-migration.js';
import {assertNoApplicationMigration} from '../packages/core/src/persistence/migration-guard.js';
import {SqliteDatabase} from '../packages/core/src/persistence/sqlite-database.js';
import {acquireSqliteAccess} from '../packages/core/src/persistence/sqlite-access.js';
const migrationTest = process.platform === 'darwin' ? test : test.skip;
async function fixture(run: (f: {roots: string[]; backup: string}) => Promise<void>) {
 const temp = await realpath(await mkdtemp('/tmp/zhx-migration-')), roots = [temp+'/personal',temp+'/code'], backup = temp+'/backup';
 try {
  for (const root of roots) { await mkdir(root,{mode:0o700}); await writeFile(root+'/identities.json',JSON.stringify({id:'preserve-id',binding:'keychain-account-reference',pendingDecision:'review-42',journal:'uncertain'}),{mode:0o600}); }
  const db = new SqliteDatabase(roots[1]+'/state.sqlite'); db.exec("CREATE TABLE conversations(id TEXT, status TEXT); INSERT INTO conversations VALUES('session-1','pending-review')"); db.close(); await chmod(roots[1]+'/state.sqlite',0o600);
  await run({roots,backup});
 } finally { await rm(temp,{recursive:true,force:true}); }
}
migrationTest('all-store snapshot resumes interrupted copying and restores bytes while retaining later writes',()=>fixture(async f=>{
 let once=true;
 await expect(applicationMigration({...f,action:'backup',afterWrite:async()=>{if(once){once=false;throw Error('crash')}}})).rejects.toThrow('crash');
 await expect(assertNoApplicationMigration(f.roots[0]!)).rejects.toThrow('APPLICATION_MIGRATION_RECOVERY_REQUIRED');
 expect((await applicationMigration({...f,action:'backup'})).phase).toBe('ready');
 await assertNoApplicationMigration(f.roots[0]!);
 const original = await readFile(f.roots[0]+'/identities.json','utf8');
 await writeFile(f.roots[0]+'/identities.json','later writes',{mode:0o600});
 await writeFile(f.roots[1]+'/new.json','new journal',{mode:0o600});
 const inspection=await applicationMigration({...f,action:'inspect-rollback'});
 let writes=0;
 await expect(applicationMigration({...f,action:'rollback',expectedCurrentSha256:inspection.currentSha256,afterWrite:async()=>{if(++writes===1)throw Error('crash')}})).rejects.toThrow('crash');
 await expect(assertNoApplicationMigration(f.roots[0]!)).rejects.toThrow();
 await applicationMigration({...f,action:'inspect-rollback'});
 await expect(assertNoApplicationMigration(f.roots[0]!)).rejects.toThrow();
 expect((await applicationMigration({...f,action:'rollback',expectedCurrentSha256:inspection.currentSha256})).phase).toBe('restored');
 expect(await readFile(f.roots[0]+'/identities.json','utf8')).toBe(original);
 const saved=await Promise.all((await readdir(f.backup+'/before-rollback')).map(p=>readFile(f.backup+'/before-rollback/'+p,'utf8')));
 expect(saved).toContain('later writes'); expect(saved).toContain('new journal');
 await writeFile(f.roots[0]+'/after-restore.json','new work',{mode:0o600});
 await expect(applicationMigration({...f,action:'rollback',expectedCurrentSha256:inspection.currentSha256})).rejects.toThrow('MIGRATION_RESTORE_ALREADY_COMPLETED');
 expect(await readFile(f.roots[0]+'/after-restore.json','utf8')).toBe('new work');
 const db=new SqliteDatabase(f.roots[1]+'/state.sqlite');try {expect(db.query<{status:string}>('SELECT status FROM conversations').get()?.status).toBe('pending-review')}finally{db.close()}
}));
migrationTest('active managed owner and open core databases exclude migration',()=>fixture(async f=>{
 const lease=acquireSqliteAccess(f.roots[0]+'/migration');
 try { await expect(applicationMigration({...f,action:'backup'})).rejects.toThrow('SQLITE_ACCESS_UNAVAILABLE'); } finally {lease?.close()}
 const db=new SqliteDatabase(f.roots[1]+'/state.sqlite');
 try {await expect(applicationMigration({...f,action:'backup'})).rejects.toThrow('SQLITE_ACCESS_UNAVAILABLE')} finally{db.close()}
 expect((await applicationMigration({...f,action:'backup'})).phase).toBe('ready');
}));
migrationTest('rollback rejects stale consent and tampered backup before overwriting data',()=>fixture(async f=>{
 await applicationMigration({...f,action:'backup'});
 const inspection=await applicationMigration({...f,action:'inspect-rollback'});
 await writeFile(f.roots[0]+'/identities.json','newer work',{mode:0o600});
 await expect(applicationMigration({...f,action:'rollback',expectedCurrentSha256:inspection.currentSha256})).rejects.toThrow('MIGRATION_ROLLBACK_CONFIRMATION_REQUIRED');
 expect(await readFile(f.roots[0]+'/identities.json','utf8')).toBe('newer work');
 const objects=await readdir(f.backup+'/objects'); await writeFile(f.backup+'/objects/'+objects[0],'corrupt',{mode:0o600});
 await expect(applicationMigration({...f,action:'rollback',expectedCurrentSha256:inspection.currentSha256})).rejects.toThrow('MIGRATION_BACKUP_CORRUPT');
 expect(await readFile(f.roots[0]+'/identities.json','utf8')).toBe('newer work');
}));
migrationTest('symlinks and overlapping roots fail closed',()=>fixture(async f=>{
 await expect(applicationMigration({...f,roots:[f.roots[0]!,f.roots[0]!],action:'backup'})).rejects.toThrow('MIGRATION_OVERLAPPING_ROOTS');
 await symlink(f.roots[1]+'/identities.json',f.roots[0]+'/escape');
 await expect(applicationMigration({...f,action:'backup'})).rejects.toThrow();
}));
migrationTest('legacy live owner PID blocks copying and changed sources cannot resume a prior snapshot',()=>fixture(async f=>{
 const setup=new SqliteDatabase(f.roots[0]+'/setup.sqlite'); setup.exec(`CREATE TABLE owner(id INTEGER PRIMARY KEY, pid INTEGER); INSERT INTO owner VALUES(1,${process.pid})`);setup.close();await chmod(f.roots[0]+'/setup.sqlite',0o600);
 await expect(applicationMigration({...f,action:'backup'})).rejects.toThrow('MIGRATION_WRITER_ACTIVE');
 const stopped=new SqliteDatabase(f.roots[0]+'/setup.sqlite');stopped.exec('DELETE FROM owner');stopped.close();
 await expect(applicationMigration({...f,action:'backup',afterWrite:async()=>{throw Error('crash')}})).rejects.toThrow('crash');
 await writeFile(f.roots[0]+'/identities.json','changed during outage',{mode:0o600});
 await expect(applicationMigration({...f,action:'backup'})).rejects.toThrow('MIGRATION_SOURCE_CHANGED');
 expect(await readFile(f.roots[0]+'/identities.json','utf8')).toBe('changed during outage');
 const inspected=await applicationMigration({...f,action:'inspect'});
 expect((await applicationMigration({...f,action:'abort',expectedCurrentSha256:inspected.currentSha256})).phase).toBe('aborted');
 await assertNoApplicationMigration(f.roots[0]!);
 expect(await readFile(f.roots[0]+'/identities.json','utf8')).toBe('changed during outage');
}));
