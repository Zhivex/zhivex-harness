import {test,expect} from "bun:test";
import {randomUUID} from "node:crypto";
import {mkdtemp,writeFile,rm} from "node:fs/promises";
import {execFileSync} from "node:child_process";
import {hostSensitiveValues,rememberSensitiveValue,desktopRedactor} from "../src/redaction.js";
import {openGitDelivery} from "../src/git-delivery.js";
test("existing redactors and Git review managers reject keys learned after construction",async()=>{
 const root=await mkdtemp('/tmp/har-credential-review-');const git=(...args:string[])=>execFileSync('git',['-C',root,...args],{stdio:'pipe'});try{git('init','-q');git('config','user.name','Fixture');git('config','user.email','fixture@example.invalid');await writeFile(root+'/note.txt','base');git('add','note.txt');git('commit','-qm','base');
 const manager=await openGitDelivery(root,root+'/delivery',hostSensitiveValues({}));const redactor=desktopRedactor([]);const first=randomUUID(),second=randomUUID();rememberSensitiveValue(first);rememberSensitiveValue(second);
 for(const secret of [first,second]){expect(redactor.text('value '+secret)).toBe('value [REDACTED]');await writeFile(root+'/note.txt',secret);git('add','note.txt');await expect(manager.reviewCommit({paths:['note.txt'],message:'review'})).rejects.toThrow('GIT_DELIVERY_SECRET_DETECTED');}
 }finally{await rm(root,{recursive:true,force:true});}
});
