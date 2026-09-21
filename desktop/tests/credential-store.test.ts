import {test,expect} from "bun:test";
import {mkdtemp,writeFile,chmod,rm} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {openCredentialStore} from "../src/credential-store.js";
async function fixture(body:string,run:(helper:string)=>Promise<void>){const dir=await mkdtemp(path.join(os.tmpdir(),"har-vault-test-"));try{const helper=path.join(dir,"helper");await writeFile(helper,`#!${process.execPath}\n${body}`);await chmod(helper,0o700);await run(helper);}finally{await rm(dir,{recursive:true,force:true});}}
test("credential helper receives no secret arguments or inherited provider environment",async()=>{
 await fixture(`const action=process.argv[2];if(process.argv.length!==3||process.env.OPENAI_API_KEY||process.cwd()!==require("node:fs").realpathSync(${JSON.stringify(os.tmpdir())}))process.exit(3);console.log(JSON.stringify(action==="read"?{status:"present",secret:"fixture-value"}:{status:action==="delete"?"deleted":action==="configure"?"saved":"present"}));`,async helper=>{
  const store=openCredentialStore(helper,{platform:"darwin"});expect(await store.status()).toBe("present");expect(await store.configure()).toBe("saved");expect(await store.read()).toEqual({status:"present",secret:"fixture-value"});expect(await store.delete()).toBe("deleted");
 });
});
test("probe sends one fixed request without redirects and never projects response body or credentials",async()=>{
 await fixture('console.log(JSON.stringify({status:"present",secret:"fixture-value"}));',async helper=>{
  for(const [code,result] of [[200,"connected"],[401,"invalid-credential"],[403,"forbidden"],[429,"rate-limited"],[500,"network-error"]] as const){let calls=0;
   const request=(async(url,init)=>{calls++;expect(url).toBe("https://api.openai.com/v1/models");expect(init?.redirect).toBe("error");expect(init?.method).toBe("GET");expect(init?.headers).toEqual({Authorization:"Bearer fixture-value"});expect(init?.signal).toBeInstanceOf(AbortSignal);return new Response("untrusted-response-with-fixture-value",{status:code});}) as typeof fetch;
   expect(await openCredentialStore(helper,{platform:"darwin",request}).probe()).toBe(result);expect(calls).toBe(1);
  }
  const request=(async()=>{throw new Error("fixture-value");}) as unknown as typeof fetch;expect(await openCredentialStore(helper,{platform:"darwin",request}).probe()).toBe("network-error");
 });
});
test("locked, missing and unsupported stores do not start network requests",async()=>{
 for(const status of ["locked","missing","unavailable","cancelled"] as const){await fixture(`console.log(JSON.stringify({status:${JSON.stringify(status)}}));`,async helper=>{const request=(async()=>{throw new Error("network should not be called");}) as unknown as typeof fetch;expect(await openCredentialStore(helper,{platform:"darwin",request}).probe()).toBe(status);});}
 const unsupported=openCredentialStore("/does-not-exist",{platform:"linux"});expect(await unsupported.status()).toBe("unsupported");expect(await unsupported.configure()).toBe("unsupported");expect(await unsupported.delete()).toBe("unsupported");
});
test("malformed, oversized, crashed and timed out helpers cannot leak output",async()=>{
 for(const script of ['console.log("fixture-value");','console.log(JSON.stringify({status:"present",secret:"fixture-value"}));','console.log("fixture-value".repeat(2000));','console.error("fixture-value");process.exit(2);'])await fixture(script,async helper=>{expect(await openCredentialStore(helper,{platform:"darwin"}).status()).toBe("unavailable");});
 await fixture('setTimeout(()=>{},10000);',async helper=>{expect(await openCredentialStore(helper,{platform:"darwin",timeoutMs:20}).status()).toBe("unavailable");});
});
test("non-OpenAI helpers select isolated accounts and probe only the matching host",async()=>{
 for(const [provider,url] of Object.entries({qwen:"https://dashscope-intl.aliyuncs.com/compatible-mode/v1/models",meta:"https://api.meta.ai/v1/models",gemini:"https://generativelanguage.googleapis.com/v1beta/models"})){
  await fixture(`if(process.argv[3]!==${JSON.stringify(provider)}||process.argv.length!==4)process.exit(4);console.log(JSON.stringify({status:"present",secret:"provider-fixture"}));`,async helper=>{
   let calls=0;const request=(async(target,init)=>{calls++;expect(target).toBe(url);expect(init?.redirect).toBe("error");expect(init?.headers).toEqual(provider==="gemini"?{"x-goog-api-key":"provider-fixture"}:{Authorization:"Bearer provider-fixture"});return new Response("{}",{status:200});}) as typeof fetch;
   expect(await openCredentialStore(helper,{provider,platform:"darwin",request}).probe()).toBe("connected");expect(calls).toBe(1);
  });
 }
 expect(()=>openCredentialStore("/tmp/helper",{provider:"deepseek"})).toThrow();
});
