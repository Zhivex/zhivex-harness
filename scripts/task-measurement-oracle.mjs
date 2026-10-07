// Executed only on trusted local fixture bytes, outside the editable workspace.
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {pathToFileURL} from 'node:url';
const [moduleFile,casesFile,exportName]=process.argv.slice(2);
const hash=bytes=>createHash('sha256').update(bytes).digest('hex');
const moduleBytes=await readFile(moduleFile),caseBytes=await readFile(casesFile);
const moduleSha256=hash(moduleBytes),casesSha256=hash(caseBytes);
const vectors=JSON.parse(caseBytes);
assert(Array.isArray(vectors)&&vectors.length>0,'EMPTY_ORACLE');
for(const vector of vectors)assert(vector&&typeof vector.id==='string'&&Object.hasOwn(vector,'input')&&Object.hasOwn(vector,'expected'),'INVALID_VECTOR');
let module;
try{module=await import(pathToFileURL(moduleFile).href);}catch{console.log(JSON.stringify({accepted:false,failures:['MODULE_LOAD'],observed:[],moduleSha256,casesSha256}));process.exit(0);}
const failures=[];const observed=[];
for(const vector of vectors){
 try{assert.equal(typeof module[exportName],'function');const input=structuredClone(vector.input),before=structuredClone(input);const value=module[exportName](input);observed.push(value);assert.deepEqual(value,vector.expected);assert.deepEqual(input,before);}
 catch{failures.push(vector.id);}
}
assert.equal(hash(await readFile(moduleFile)),moduleSha256,'MODULE_CHANGED_DURING_ORACLE');
assert.equal(hash(await readFile(casesFile)),casesSha256,'CASES_CHANGED_DURING_ORACLE');
console.log(JSON.stringify({accepted:failures.length===0,failures,observed,moduleSha256,casesSha256}));
