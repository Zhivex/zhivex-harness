import { test,expect } from "bun:test";
import { mkdtemp,mkdir,writeFile,readFile,rm,symlink,chmod } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import { openProjectRegistry } from "../src/projects.js";

test("recent projects preserve canonical identity, concurrent writes and uncommitted files",async()=>{
 const root=await mkdtemp("/tmp/har-project-registry-");try{
  const repos=[root+"/one",root+"/two"];for(const repo of repos){await mkdir(repo);execFileSync("git",["init","-q",repo]);await writeFile(repo+"/uncommitted.txt","preserve me");}
  await mkdir(repos[0]+"/nested");await symlink(repos[0]!,root+"/alias");
  const registry=await openProjectRegistry(root+"/index");
  const entries=await Promise.all(repos.map(repo=>registry.select(repo)));expect(registry.list()).toHaveLength(2);
  expect((await registry.select(root+"/alias/nested")).key).toBe(entries[0]!.key);expect(registry.list()).toHaveLength(2);
  const loaded=await openProjectRegistry(root+"/index");expect(loaded.list()).toEqual(registry.list());
  for(const repo of repos)expect(await readFile(repo+"/uncommitted.txt","utf8")).toBe("preserve me");
  expect(()=>registry.get("/arbitrary/path")).toThrow("PROJECT_NOT_FOUND");
  await mkdir(root+"/plain");await expect(registry.select(root+"/plain")).rejects.toThrow("PROJECT_NOT_REPOSITORY");expect(registry.list()).toHaveLength(2);
 }finally{await rm(root,{recursive:true,force:true});}
});

test("project index rejects linked, public or forged persisted identities",async()=>{
 const root=await mkdtemp("/tmp/har-project-index-");try{
  await mkdir(root+"/private",{mode:0o700});await mkdir(root+"/public",{mode:0o755});await symlink(root+"/private",root+"/link");
  await expect(openProjectRegistry(root+"/public")).rejects.toThrow("PROJECT_DIRECTORY_UNSAFE");await expect(openProjectRegistry(root+"/link")).rejects.toThrow("PROJECT_DIRECTORY_UNSAFE");
  await writeFile(root+"/private/projects.json",JSON.stringify({schemaVersion:1,projects:[{key:"project_"+"a".repeat(32),workspace:"/tmp/forged",name:"forged",lastOpenedAt:0}]}),{mode:0o600});
  await expect(openProjectRegistry(root+"/private")).rejects.toThrow("PROJECT_INDEX_INVALID");
  await chmod(root+"/private/projects.json",0o644);await expect(openProjectRegistry(root+"/private")).rejects.toThrow("PROJECT_INDEX_UNSAFE");
 }finally{await rm(root,{recursive:true,force:true});}
});
