import {afterEach,expect,test} from "bun:test";
import {mkdtemp,writeFile,readFile,rm,symlink,readdir} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {createHash} from "node:crypto";
import {Workspace} from "../src/workspace.js";
import {createEditProposal} from "../src/edit-contracts.js";
import {attachApprovalPreviews} from "../src/approval-preview.js";
import type {HarnessClientRun} from "../src/client-contract.js";
const dirs:string[]=[];
const digest=(s:string|Buffer)=>`sha256:${createHash("sha256").update(s).digest("hex")}` as const;
async function setup(){const dir=await mkdtemp(path.join(os.tmpdir(),"har-preview-"));dirs.push(dir);return {dir,workspace:await Workspace.open(dir)};}
afterEach(async()=>{await Promise.all(dirs.splice(0).map(dir=>rm(dir,{recursive:true,force:true})));});
test("complete replacement preview preserves BOM, CRLF and unchanged context without mutation",async()=>{
 const {dir,workspace}=await setup(),before="\ufeffcontext\r\nold\r\nlast",after=before.replace("old","new");await writeFile(path.join(dir,"a.txt"),before);
 const edit={path:"a.txt",expectedDigest:digest(before),oldText:"old",newText:"new"};
 const preview=await workspace.previewReplacement(edit);
 expect(preview.files).toEqual([{path:"a.txt",expectedDigest:digest(before),before,after,afterDigest:digest(after)}]);
 expect(await readFile(path.join(dir,"a.txt"),"utf8")).toBe(before);expect(await readdir(dir)).toEqual(["a.txt"]);
 await workspace.applyReplacement(edit);expect(await readFile(path.join(dir,"a.txt"),"utf8")).toBe(after);
});
test("preview rejects stale, ambiguous, non-UTF8, symlink and protected bases",async()=>{
 const {dir,workspace}=await setup();await writeFile(path.join(dir,"a.txt"),"old old");
 await expect(workspace.previewReplacement({path:"a.txt",expectedDigest:digest("old old"),oldText:"old",newText:"new"})).rejects.toThrow("exactly one");
 const change={path:"a.txt",expectedDigest:digest("stale"),content:"new"};
 const preview=(c:typeof change)=>workspace.previewPatch({changes:[c],proposalId:createEditProposal({changes:[c]}).proposalId});
 await expect(preview(change)).rejects.toThrow("Stale");
 await symlink(path.join(dir,"a.txt"),path.join(dir,"link.txt"));await expect(preview({...change,path:"link.txt"})).rejects.toThrow();
 await writeFile(path.join(dir,".env"),"secret");await expect(preview({...change,path:".env",expectedDigest:digest("secret")})).rejects.toThrow("protected");
 const invalid=Buffer.from([0xff,0xfe]);await writeFile(path.join(dir,"a.txt"),invalid);await expect(preview({...change,expectedDigest:digest(invalid)})).rejects.toThrow("UTF-8");
});
test("create preview is absence-bound and service projection degrades stale approvals without leaking errors",async()=>{
 const {dir,workspace}=await setup(),changes=[{path:"new.txt",expectedDigest:null,content:"new"}];
 const args={changes,proposalId:createEditProposal({changes}).proposalId};
 const run=():HarnessClientRun=>({runId:"r",revision:4,status:"waiting_approval",output:"",approvals:[{approvalId:"a",digest:"a".repeat(64),provider:"p",kind:"tool",expiresAt:123,action:{name:"apply_patch",arguments:JSON.stringify(args)}}]});
 expect((await attachApprovalPreviews(run(),workspace)).approvals[0]!.filePreview).toMatchObject({status:"complete",files:[{before:null,after:"new"}]});
 expect(await readdir(dir)).toEqual([]);await writeFile(path.join(dir,"new.txt"),"concurrent");
 expect((await attachApprovalPreviews(run(),workspace)).approvals[0]!.filePreview).toEqual({status:"unavailable"});
});
