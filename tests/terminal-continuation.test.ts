import {expect,test} from "bun:test";
import {terminalContinuationMessages} from "../src/cli/terminal/terminal-continuation.js";
import type {ModelMessage} from "@zhivex-ai/core";
test("terminal transcript gaps become explicit unknown results without fabricating success or modifying history",()=>{
 const messages:ModelMessage[]=[{role:"assistant",parts:[{type:"tool-call",toolCall:{id:"missing",name:"apply_patch",input:{}}},{type:"tool-call",toolCall:{id:"recorded",name:"read_file",input:{}}}]},{role:"tool",parts:[{type:"tool-result",toolResult:{toolCallId:"recorded",toolName:"read_file",output:{content:"actual"},isError:false}}]}];
 const copy=structuredClone(messages),next=terminalContinuationMessages(messages);
 expect(messages).toEqual(copy);expect(next).toHaveLength(3);
 expect(next[1]).toMatchObject({role:"tool",parts:[{type:"tool-result",toolResult:{toolCallId:"missing",isError:true,output:{status:"outcome_unknown"}}}]});
 expect(next[2]).toEqual(messages[1]);expect(terminalContinuationMessages(next)).toEqual(next);
});
