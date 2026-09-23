import { describe, expect, test } from "bun:test";
import { createMeta } from "@zhivex-ai/meta";
import { providerModelInternals } from "../src/providers/providers.js";
import type { ModelGenerateInput } from "@zhivex-ai/core";

describe("Meta agent transport", () => {
  for (const mode of ["generate", "stream"] as const) {
    test(`${mode} uses Responses and preserves a function receipt`, async () => {
      let endpoint = "";
      let body: any;
      const model = providerModelInternals.withMetaResponses(createMeta({apiKey:"fixture", fetch:(async (url,init)=>{
        endpoint=String(url); body=JSON.parse(String(init?.body));
        const response={id:"resp_fixture",status:"completed",output:[{type:"message",role:"assistant",content:[{type:"output_text",text:"parent-ok"}]}]};
        return mode === "generate" ? Response.json(response) : new Response([
          {type:"response.output_text.delta",delta:"parent-ok"},
          {type:"response.completed",response}
        ].map(e=>`data: ${JSON.stringify(e)}\n\n`).join(""));
      }) as typeof fetch})("muse-spark-1.3"));
      const input:ModelGenerateInput={providerOptions:{apiMode:"chat"},messages:[
        {role:"user",parts:[{type:"text",text:"Respond parent-ok after reviewing."}]},
        {role:"assistant",parts:[{type:"tool-call",toolCall:{id:"call_review",name:"delegate_reviewer",input:{taskId:"review"}}}]},
        {role:"tool",parts:[{type:"tool-result",toolResult:{toolCallId:"call_review",toolName:"delegate_reviewer",isError:false,output:{status:"completed",outputText:"child-ok"}}}]}
      ]};
      let text="";
      if(mode === "generate") text=(await model.generate(input)).text ?? "";
      else for await(const event of await model.stream!(input)) if(event.type === "text-delta") text+=event.textDelta;
      expect(endpoint.endsWith("/responses")).toBe(true);
      expect(body.input.at(-1)).toMatchObject({type:"function_call_output",call_id:"call_review"});
      expect(body.input.at(-1).output).toContain("child-ok");
      expect(text).toBe("parent-ok");
    });
  }
});
