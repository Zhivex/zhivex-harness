import { expect, test } from "bun:test";
import { manageWebRuntime } from "../src/managed-runtime.js";
import type { WebRuntime } from "../src/runtime.js";
import type { WebModelChoice } from "../src/contracts.js";

function fixture(status = "completed") {
  const log: string[] = [];
  const choices: WebModelChoice[] = [
    {provider:"openai",providerName:"OpenAI",model:"first",name:"First",configured:true,capabilities:["chat","tools"],validation:"verified"},
    {provider:"anthropic",providerName:"Anthropic",model:"next",name:"Next",configured:true,capabilities:["chat","tools"],validation:"verified"},
    {provider:"gemini",providerName:"Gemini",model:"missing",name:"Missing",configured:false,capabilities:["chat","tools"],validation:"unverified"},
  ];
  let wait: Promise<void> | undefined;
  const runtime = (provider: string, model: string): WebRuntime => ({
    workspace:{key:"project",workspace:"fixture",name:"fixture",provider,model},
    async command(value: Record<string, unknown>) {
      if(value.method === "session.list") return {ok:true,data:{kind:"sessions",sessions:[{runs:[{status}]}]}};
      await wait; return {ok:true,data:{kind:"project",projectId:"project"}};
    },
    async close(){ log.push(`close:${model}`); },
    async events(){return {};}, async review(){return {};}, async decide(){return {};}, forgetIdentity(){},
  } as unknown as WebRuntime);
  const initial = runtime("openai","first");
  const prepare = async (selection: {provider: string; model: string}) => {
    log.push(`prepare:${selection.model}`);
    return {async attach(){log.push(`attach:${selection.model}`);return runtime(selection.provider,selection.model);},
      async dispose(){log.push(`dispose:${selection.model}`);}};
  };
  return {log,initial,choices,prepare,setWait(value: Promise<void>){wait=value;}};
}

test("model selection applies an authenticated host choice after retiring one owner", async () => {
  const f=fixture(); const runtime=manageWebRuntime(f.initial,async()=>f.choices,f.prepare);
  await runtime.selectModel!({provider:"anthropic",model:"next"});
  expect(runtime.workspace.model).toBe("next");
  expect(f.log).toEqual(["prepare:next","close:first","attach:next"]);
});
test("missing credentials and unknown model IDs cannot create a new host", async () => {
  const f=fixture();const runtime=manageWebRuntime(f.initial,async()=>f.choices,f.prepare);
  for(const selection of [{provider:"gemini",model:"missing"},{provider:"openai",model:"arbitrary"}])
    await expect(runtime.selectModel!(selection)).rejects.toThrow("WEB_MODEL_NOT_CONFIGURED");
  expect(f.log).toEqual([]); expect(runtime.workspace.model).toBe("first");
});
test("any active or waiting-approval session blocks model change without touching tickets/owner", async () => {
  for(const status of ["created","running","waiting_approval","cancel_requested"]) {
    const f=fixture(status);const runtime=manageWebRuntime(f.initial,async()=>f.choices,f.prepare);
    await expect(runtime.selectModel!({provider:"anthropic",model:"next"})).rejects.toThrow("WEB_MODEL_CHANGE_BUSY");
    expect(f.log).toEqual([]);
  }
});
test("in-flight starts and repeated model changes cannot race service replacement", async () => {
  const f=fixture();let release!:()=>void;f.setWait(new Promise(resolve=>{release=resolve;}));
  const runtime=manageWebRuntime(f.initial,async()=>f.choices,f.prepare);
  const start=runtime.command({method:"run.start"});
  await expect(runtime.selectModel!({provider:"anthropic",model:"next"})).rejects.toThrow("WEB_MODEL_CHANGE_BUSY");
  release();await start;
  const change=runtime.selectModel!({provider:"anthropic",model:"next"});
  await expect(runtime.selectModel!({provider:"anthropic",model:"next"})).rejects.toThrow("WEB_MODEL_CHANGE_IN_PROGRESS");
  await expect(runtime.command({method:"run.start"})).rejects.toThrow("WEB_MODEL_CHANGE_IN_PROGRESS");
  await change;expect(f.log.filter(x=>x==="attach:next")).toHaveLength(1);
});
test("credential/config validation failure preserves the current host", async () => {
  const f=fixture();const runtime=manageWebRuntime(f.initial,async()=>f.choices,async()=>{throw Error("WEB_CREDENTIALS_REQUIRED");});
  await expect(runtime.selectModel!({provider:"anthropic",model:"next"})).rejects.toThrow("WEB_CREDENTIALS_REQUIRED");
  expect(f.log).toEqual([]);expect(runtime.workspace.model).toBe("first");
});
test("failed attach rolls back the prior model without recovering/stealing a lease", async () => {
  const f=fixture();const runtime=manageWebRuntime(f.initial,async()=>f.choices,async selection=>{
    const prepared=await f.prepare(selection);
    return {...prepared,async attach(){if(selection.model==="next")throw Error("LOCAL_SERVICE_STALE_STATE");return prepared.attach();}};
  });
  await expect(runtime.selectModel!({provider:"anthropic",model:"next"})).rejects.toThrow("WEB_MODEL_SWITCH_FAILED");
  expect(runtime.workspace.model).toBe("first");
  expect(f.log).toEqual(["prepare:next","close:first","dispose:next","prepare:first","attach:first"]);
});
test("shutdown during model preparation disposes the candidate and closes the original", async () => {
  const f=fixture();let release!:()=>void;const ready=new Promise<void>(resolve=>{release=resolve;});
  const runtime=manageWebRuntime(f.initial,async()=>f.choices,async selection=>{await ready;return f.prepare(selection);});
  const change=runtime.selectModel!({provider:"anthropic",model:"next"});
  await Promise.resolve();await Promise.resolve();const stopped=runtime.close();release();
  await expect(change).rejects.toThrow("WEB_MODEL_UNAVAILABLE");await stopped;
  expect(f.log).not.toContain("attach:next");expect(f.log).toContain("dispose:next");expect(f.log).toContain("close:first");
});
