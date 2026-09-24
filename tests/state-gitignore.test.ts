import {expect, test} from "bun:test";
import {mkdtemp, realpath, rm, mkdir, writeFile, readFile, symlink, link} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {spawnSync} from "node:child_process";
import {openCliSessionStore} from "../src/persistence/sessions.js";
import {openHarnessPersistence} from "../src/persistence/operations.js";
import {resolveHarnessConfig} from "../src/runtime/config.js";
import {protectStateFromGit} from "../src/persistence/state-gitignore.js";

async function fixture(run:(root:string)=>Promise<void>) {
 const root=await realpath(await mkdtemp(path.join(os.tmpdir(),"harness-gitignore-")));
 try {await run(root);} finally {await rm(root,{recursive:true,force:true});}
}
function git(root:string,...args:string[]) {
 const result=spawnSync("git",["-C",root,...args],{encoding:"utf8"});
 expect(result.status).toBe(0); return result.stdout;
}

for(const kind of ["sessions","sqlite","file"] as const) test(`${kind} state cannot enter an ordinary git add`,()=>fixture(async root=>{
 git(root,"init","--quiet");
 const stateDirectory=path.join(root,...(kind==="file"?["custom-state"]:[".zhivex-harness","runs"]));
 if(kind==="sessions") {
  const store=await openCliSessionStore({workspace:root,stateDirectory,scope:{tenantId:"local",namespace:"test"}});
  try {await store.create({title:"private session"});} finally {store.close();}
 } else {
  const persistence=await openHarnessPersistence(resolveHarnessConfig({workspace:root,stateDirectory,storeBackend:kind}));
  persistence.close();
 }
 for(const name of ["operations.sqlite-wal","operations.sqlite-shm","future-state.json"])await writeFile(path.join(stateDirectory,name),"private");
 await writeFile(path.join(root,"README.md"),"public");
 git(root,"add","--all");
 expect(git(root,"ls-files").trim()).toBe("README.md");
 expect(git(root,"check-ignore",path.relative(root,path.join(stateDirectory,"operations.sqlite-wal")))).toContain("operations.sqlite-wal");
}));

test("preserves existing ignore rules, overrides negations and is idempotent",()=>fixture(async root=>{
 const state=path.join(root,"state");await mkdir(state);
 const ignore=path.join(state,".gitignore");await writeFile(ignore,"# custom\n!operations.sqlite");
 await protectStateFromGit(root,state); const first=await readFile(ignore,"utf8");
 await protectStateFromGit(root,state);
 expect(await readFile(ignore,"utf8")).toBe(first);
 expect(first).toStartWith("# custom\n!operations.sqlite\n");
 git(root,"init","--quiet");await writeFile(path.join(state,"operations.sqlite"),"private");
 expect(git(root,"check-ignore","state/operations.sqlite")).toContain("state/operations.sqlite");
}));

for(const alias of ["symlink","hardlink"] as const)test(`rejects ${alias} ignore files without modifying their target`,()=>fixture(async root=>{
 const state=path.join(root,"state");await mkdir(state);
 const target=path.join(root,"target");await writeFile(target,"unchanged");
 await (alias==="symlink"?symlink:link)(target,path.join(state,".gitignore"));
 await expect(protectStateFromGit(root,state)).rejects.toThrow("safe .gitignore");
 expect(await readFile(target,"utf8")).toBe("unchanged");
}));

for(const size of [65535,65536]) test(`state ignore at ${size} bytes can reopen after protection`,()=>fixture(async root=>{
 const state=path.join(root,"state");await mkdir(state);
 const ignore=path.join(state,".gitignore");const original="#".repeat(size);
 await writeFile(ignore,original);
 await protectStateFromGit(root,state);const protectedContent=await readFile(ignore,"utf8");
 expect(protectedContent).toStartWith(original+"\n");
 await protectStateFromGit(root,state);
 expect(await readFile(ignore,"utf8")).toBe(protectedContent);
}));

test("oversized user ignore files are rejected without appending",()=>fixture(async root=>{
 const state=path.join(root,"state");await mkdir(state);
 const ignore=path.join(state,".gitignore"), original="#".repeat(65537);
 await writeFile(ignore,original);
 await expect(protectStateFromGit(root,state)).rejects.toThrow("safe .gitignore");
 expect(await readFile(ignore,"utf8")).toBe(original);
}));
