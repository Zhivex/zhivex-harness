import {test,expect} from "bun:test";
import {mkdtemp,readFile,rm} from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import {randomUUID} from "node:crypto";
import {protectPersistenceSecret} from "../../src/persistence-secrets.js";
import {SqliteDatabase} from "../../src/sqlite-database.js";
test("known credentials are rejected before SQL, positional/named/numbered binds and blobs reach disk",async()=>{
 const dir=await mkdtemp(path.join(os.tmpdir(),"har-secret-db-"));const filename=path.join(dir,"state.sqlite");const db=new SqliteDatabase(filename);const secret='fixture-'+randomUUID()+'"\\tail';protectPersistenceSecret(secret);
 try{db.exec('PRAGMA journal_mode=WAL; CREATE TABLE records(value TEXT)');db.query('INSERT INTO records VALUES (?)').run('safe-before');
  const attempts=[()=>db.exec(`INSERT INTO records VALUES ('${secret}')`),()=>db.query(`SELECT '${secret}'`),()=>db.query('INSERT INTO records VALUES (?)').run(secret),()=>db.query('INSERT INTO records VALUES (?1)').run(JSON.stringify({credential:secret})),()=>db.query('INSERT INTO records VALUES ($value)').run({$value:secret}),()=>db.query('INSERT INTO records VALUES (?)').run(Buffer.from(secret))];
  for(const attempt of attempts){try{attempt();throw new Error('not rejected');}catch(error){expect((error as Error).message).toBe('PERSISTENCE_SECRET_REJECTED');expect(String(error)).not.toContain(secret);}}
  db.query('INSERT INTO records VALUES (?)').run('safe-after');expect(db.query<{value:string}>('SELECT value FROM records').all()).toEqual([{value:'safe-before'},{value:'safe-after'}]);
  for(const suffix of ['','-wal']){const bytes=await readFile(filename+suffix);expect(bytes.includes(Buffer.from(secret))).toBe(false);expect(bytes.includes(Buffer.from(JSON.stringify(secret).slice(1,-1)))).toBe(false);}
 }finally{db.close();await rm(dir,{recursive:true,force:true});}
});
test("a rotated key remains protected for late results and old serialized state",()=>{const db=new SqliteDatabase(':memory:');db.exec('CREATE TABLE records(value TEXT)');try{const first=randomUUID(),second=randomUUID();protectPersistenceSecret(first);protectPersistenceSecret(second);for(const secret of [first,second])expect(()=>db.query('INSERT INTO records VALUES (?)').run(secret)).toThrow('PERSISTENCE_SECRET_REJECTED');expect(db.query('SELECT * FROM records').all()).toHaveLength(0);}finally{db.close();}});

test("prepared SQL is rechecked when a credential becomes known later",()=>{const db=new SqliteDatabase(':memory:');try{db.exec('CREATE TABLE records(value TEXT)');const secret=randomUUID();const prepared=db.query(`INSERT INTO records VALUES ('${secret}')`);protectPersistenceSecret(secret);expect(()=>prepared.run()).toThrow('PERSISTENCE_SECRET_REJECTED');expect(db.query('SELECT * FROM records').all()).toHaveLength(0);}finally{db.close();}});
test("a provider echo cannot enter durable run state and a later safe run still completes",async()=>{
 const {createHarness,runHarness}=await import("../../src/harness.js");const {createMockLanguageModel}=await import("@zhivex-ai/agents/testing");const {readdir}=await import("node:fs/promises");
 const dir=await mkdtemp(path.join(os.tmpdir(),"har-secret-runtime-"));const stateDirectory=path.join(dir,"state");const secret=randomUUID();protectPersistenceSecret(secret);let harness:Awaited<ReturnType<typeof createHarness>>|undefined;
 try{harness=await createHarness({workspace:dir,stateDirectory,storeBackend:"sqlite",projectContext:false,subagentProfiles:[],modelInstance:createMockLanguageModel({streamEvents:[[{type:"text-delta",textDelta:secret},{type:"finish",finishReason:"stop"}],[{type:"text-delta",textDelta:"safe answer"},{type:"finish",finishReason:"stop"}]]})});
  let rejected=false;try{await runHarness(harness,{prompt:"Reply with a diagnostic"});}catch(error){rejected=true;expect(String(error)).not.toContain(secret);}expect(rejected).toBe(true);
  const safe=await runHarness(harness,{prompt:"Reply safely"});expect(safe.status).toBe("completed");
  const scan=async(directory:string):Promise<void>=>{for(const entry of await readdir(directory,{withFileTypes:true})){const filename=path.join(directory,entry.name);if(entry.isDirectory())await scan(filename);else if(entry.isFile())expect((await readFile(filename)).includes(Buffer.from(secret))).toBe(false);}};await scan(stateDirectory);
 }finally{await harness?.close();await rm(dir,{recursive:true,force:true});}
});
