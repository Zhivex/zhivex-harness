import {test,expect} from "bun:test";
import {execFileSync} from "node:child_process";
import {mkdtemp,mkdir,writeFile,readFile,rm,chmod,lstat} from "node:fs/promises";
import {openTaskWorktrees} from "../src/task-worktrees.js";
import {openProjectRegistry} from "../src/projects.js";
const git=(workspace:string,args:string[])=>execFileSync("git",["-C",workspace,"-c","core.hooksPath=/dev/null","-c","commit.gpgsign=false","-c","user.name=Fixture","-c","user.email=fixture@example.invalid",...args],{encoding:"utf8"}).trim();
async function fixture(){
 const root=await mkdtemp("/tmp/har-worktrees-"),repo=root+"/repo";await mkdir(repo);git(repo,["init","-q","-b","main"]);
 await writeFile(repo+"/a.txt","base\n");await writeFile(repo+"/.gitattributes","*.txt filter=hostile\n");git(repo,["add","a.txt",".gitattributes"]);git(repo,["commit","-qm","base"]);
 const registry=await openProjectRegistry(root+"/projects"),project=await registry.select(repo),manager=await openTaskWorktrees(root+"/tasks");
 return{root,repo,project,manager,close:()=>rm(root,{recursive:true,force:true})};
}
test("two committed-head worktrees persist independently without copying staged, unstaged or untracked source changes",async()=>{
 const f=await fixture();try{
  await writeFile(f.repo+"/a.txt","staged\n");git(f.repo,["add","a.txt"]);await writeFile(f.repo+"/a.txt","unstaged\n");await writeFile(f.repo+"/private.txt","untracked\n");
  const [a,b]=await Promise.all([f.manager.create(f.project,{title:"One",initialState:"committed-head"}),f.manager.create(f.project,{title:"Two",branch:"feat/second-task",initialState:"committed-head"})]);
  expect(a.workspace).not.toBe(b.workspace);expect(a.branch).not.toBe(b.branch);expect(a.status).toBe("ready");expect(b.status).toBe("ready");
  for(const task of [a,b]){expect(await readFile(task.workspace+"/a.txt","utf8")).toBe("base\n");await expect(lstat(task.workspace+"/private.txt")).rejects.toThrow();}
  await writeFile(a.workspace+"/a.txt","task one\n");await writeFile(b.workspace+"/a.txt","task two\n");
  const reopened=await openTaskWorktrees(f.root+"/tasks");expect(reopened.list()).toEqual(f.manager.list());
  expect((await reopened.inspect(a.id)).changedPaths).toEqual(["a.txt"]);expect(await readFile(b.workspace+"/a.txt","utf8")).toBe("task two\n");
  expect(await readFile(f.repo+"/a.txt","utf8")).toBe("unstaged\n");expect(git(f.repo,["show",":a.txt"])).toBe("staged");expect(await readFile(f.repo+"/private.txt","utf8")).toBe("untracked\n");
 }finally{await f.close();}
});
test("cleanup reviews dirty paths and unmerged commits, invalidates stale tickets and preserves branches",async()=>{
 const f=await fixture();try{
  const task=await f.manager.create(f.project,{title:"Cleanup",initialState:"committed-head"});
  const clean=await f.manager.reviewRemoval(task.id);expect(clean.canRemove).toBe(true);
  await writeFile(task.workspace+"/untracked.txt","keep");await expect(f.manager.remove(clean.ticketId)).rejects.toThrow("TASK_REVIEW_CHANGED");await expect(f.manager.remove(clean.ticketId)).rejects.toThrow("TASK_REVIEW_REQUIRED");
  const dirty=await f.manager.reviewRemoval(task.id);expect(dirty.changedPaths).toEqual(["untracked.txt"]);expect(dirty.canRemove).toBe(false);await expect(f.manager.remove(dirty.ticketId)).rejects.toThrow("TASK_HAS_UNINTEGRATED_CHANGES");
  git(task.workspace,["add","untracked.txt"]);git(task.workspace,["commit","-qm","task change"]);
  const unmerged=await f.manager.reviewRemoval(task.id);expect(unmerged.unmergedCommits).toBe(1);expect(unmerged.canRemove).toBe(false);await expect(f.manager.remove(unmerged.ticketId)).rejects.toThrow("TASK_HAS_UNINTEGRATED_CHANGES");
  git(f.repo,["merge","--ff-only",task.branch]);
  const integrated=await f.manager.reviewRemoval(task.id);expect(integrated.canRemove).toBe(true);
  expect((await f.manager.remove(integrated.ticketId)).status).toBe("removed");await expect(lstat(task.workspace)).rejects.toThrow();expect(git(f.repo,["rev-parse",`refs/heads/${task.branch}`])).toBe(integrated.head);
  expect((await openTaskWorktrees(f.root+"/tasks")).get(task.id).status).toBe("removed");
 }finally{await f.close();}
});
test("worktree creation, status and cleanup never run repository checkout hooks or filters",async()=>{
 const f=await fixture();try{
  const marker=f.root+"/executed";
  await writeFile(f.repo+"/.git/hooks/post-checkout",`#!/bin/sh\necho hook > '${marker}'\n`);await chmod(f.repo+"/.git/hooks/post-checkout",0o755);
  for(const name of ["clean","smudge","process"])git(f.repo,["config",`filter.hostile.${name}`,`sh -c 'echo filter > ${marker}; cat'`]);git(f.repo,["config","filter.hostile.required","true"]);
  const task=await f.manager.create(f.project,{title:"No repository programs",initialState:"committed-head"});expect(await readFile(task.workspace+"/a.txt","utf8")).toBe("base\n");
  const review=await f.manager.reviewRemoval(task.id);expect(review.canRemove).toBe(true);await f.manager.remove(review.ticketId);await expect(lstat(marker)).rejects.toThrow();
 }finally{await f.close();}
});
test("invalid initial policies and branch collisions preserve an actionable record without deleting existing work",async()=>{
 const f=await fixture();try{
  await expect(f.manager.create(f.project,{title:"Invalid",initialState:"working-tree"})).rejects.toThrow();expect(f.manager.list()).toHaveLength(0);
  const task=await f.manager.create(f.project,{title:"One",branch:"feat/fixed",initialState:"committed-head"});
  await expect(f.manager.create(f.project,{title:"Collision",branch:task.branch,initialState:"committed-head"})).rejects.toThrow("TASK_CREATION_INCOMPLETE");
  expect(f.manager.list().map(task=>task.status)).toEqual(["ready","needs-attention"]);expect(await readFile(task.workspace+"/a.txt","utf8")).toBe("base\n");
 }finally{await f.close();}
});
test("ignored files and Git locks block cleanup, and forged persisted paths are rejected",async()=>{
 const f=await fixture();try{
  const task=await f.manager.create(f.project,{title:"Preserve ignored data",initialState:"committed-head"});
  await writeFile(f.repo+"/.git/info/exclude","local.env\n");await writeFile(task.workspace+"/local.env","fixture private data");
  const ignored=await f.manager.reviewRemoval(task.id);expect(ignored.changedPaths).toEqual(["local.env"]);expect(ignored.canRemove).toBe(false);await expect(f.manager.remove(ignored.ticketId)).rejects.toThrow("TASK_HAS_UNINTEGRATED_CHANGES");expect(await readFile(task.workspace+"/local.env","utf8")).toBe("fixture private data");
  await rm(task.workspace+"/local.env");git(f.repo,["worktree","lock",task.workspace]);const locked=await f.manager.reviewRemoval(task.id);expect(locked.locked).toBe(true);expect(locked.canRemove).toBe(false);await expect(f.manager.remove(locked.ticketId)).rejects.toThrow("TASK_LOCKED");git(f.repo,["worktree","unlock",task.workspace]);
  const index=JSON.parse(await readFile(f.root+"/tasks/tasks.json","utf8"));index.tasks[0].workspace=f.repo;await writeFile(f.root+"/tasks/tasks.json",JSON.stringify(index));await expect(openTaskWorktrees(f.root+"/tasks")).rejects.toThrow("TASK_IDENTITY_INVALID");
 }finally{await f.close();}
});
test("restart marks interrupted creation for attention without replaying Git or removing files",async()=>{
 const f=await fixture();try{
  const task=await f.manager.create(f.project,{title:"Interrupted checkpoint",initialState:"committed-head"});await writeFile(task.workspace+"/user.txt","preserve");
  const index=JSON.parse(await readFile(f.root+"/tasks/tasks.json","utf8"));index.tasks[0].status="creating";await writeFile(f.root+"/tasks/tasks.json",JSON.stringify(index));
  const reopened=await openTaskWorktrees(f.root+"/tasks");expect(reopened.get(task.id)).toMatchObject({status:"needs-attention",error:"TASK_CREATION_INTERRUPTED",branch:task.branch,baseCommit:task.baseCommit});
  expect(await readFile(task.workspace+"/user.txt","utf8")).toBe("preserve");expect(git(task.workspace,["rev-parse","HEAD"])).toBe(task.baseCommit);
 }finally{await f.close();}
});
