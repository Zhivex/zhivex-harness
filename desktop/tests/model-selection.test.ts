import {test, expect} from "bun:test";
import {mkdtemp, mkdir, rm} from "node:fs/promises";
import {execFileSync} from "node:child_process";
import {desktopProviders, defaultModelSelection, modelSelectionSchema, providerEnvironment} from "../src/model-selection.js";
import {openProjectRegistry} from "../src/projects.js";
import {prepareModelTransition} from "../src/model-transition.js";
import type {HarnessClientResponse} from "../../src/client/index.js";

test("existing providers map only their own Keychain credential into the runtime",()=>{
 expect(desktopProviders().map(p=>p.id).sort()).toEqual(["gemini","meta","openai","qwen"]);
 for(const [provider,key] of Object.entries({openai:"OPENAI_API_KEY",qwen:"DASHSCOPE_API_KEY",meta:"MODEL_API_KEY",gemini:"GEMINI_API_KEY"})){
  expect(providerEnvironment({provider,model:"test-model"},"fixture-secret")).toEqual({[key]:"fixture-secret"});
  expect(providerEnvironment({provider,model:"test-model"})).toEqual({});
 }
 for(const bad of [{provider:"deepseek",model:"test"},{provider:"qwen",model:""},{provider:"qwen",model:"x\ny"},{provider:"qwen",model:"test",baseURL:"https://untrusted.test"}]) expect(modelSelectionSchema.safeParse(bad).success).toBe(false);
});
test("model choice survives reopen and project visits without changing another project",async()=>{
 const root=await mkdtemp("/tmp/har-model-registry-");
 try{
  for(const name of ["one","two"]){await mkdir(`${root}/${name}`);execFileSync("git",["init","-q",`${root}/${name}`]);}
  const registry=await openProjectRegistry(`${root}/index`);
  const one=await registry.select(`${root}/one`),two=await registry.select(`${root}/two`);
  expect(one.modelSelection??defaultModelSelection()).toEqual(defaultModelSelection());
  const selection={provider:"qwen",model:"qwen3.8-max"};
  await registry.setModel(one.key,selection);
  await Promise.all([registry.select(one.workspace),registry.select(two.workspace)]);
  const reopened=await openProjectRegistry(`${root}/index`);
  expect(reopened.get(one.key).modelSelection).toEqual(selection);
  expect(reopened.get(two.key).modelSelection).toBeUndefined();
  await expect(registry.setModel(one.key,{...selection,secret:"not-allowed"})).rejects.toThrow();
  expect(registry.get(one.key).modelSelection).toEqual(selection);
 }finally{await rm(root,{recursive:true,force:true});}
});
test("switching rejects active execution and durable approvals, resuming admission on rejection",async()=>{
 for(const status of ["completed","waiting_approval","interrupted","running"]){
  const events:string[]=[];
  const host={isAlive:()=>true,controlClose:async(action:"pause"|"resume")=>{events.push(action);return status==="running";},close:async()=>{},command:async()=>({ok:true,data:{kind:"sessions",sessions:[{runs:[{status}]}]}} as unknown as HarnessClientResponse)};
  if(status==="completed"){await prepareModelTransition(host);expect(events).toEqual(["pause"]);}
  else{await expect(prepareModelTransition(host)).rejects.toThrow("MODEL_WORK_ACTIVE");expect(events).toEqual(["pause","resume"]);}
 }
});

test("unconfigured providers open history but have no callable generation transport",async()=>{
 const {desktopProviderModel}=await import("../src/provider-model.js");
 for(const p of desktopProviders()){
  const model=desktopProviderModel({provider:p.id,model:p.defaultModel});
  expect(model.modelId).toBe(p.defaultModel);
  await expect(model.generate({messages:[]})).rejects.toThrow("MODEL_CREDENTIAL_REQUIRED");
  await expect(model.stream!({messages:[]})).rejects.toThrow("MODEL_CREDENTIAL_REQUIRED");
 }
});

test("a dead runtime cannot authorize a model switch without recovering its state",async()=>{
 let read=false;
 await expect(prepareModelTransition({isAlive:()=>false,controlClose:async()=>false,close:async()=>{},command:async()=>{read=true;throw new Error();}})).rejects.toThrow("MODEL_STATE_UNAVAILABLE");
 expect(read).toBe(false);
});
