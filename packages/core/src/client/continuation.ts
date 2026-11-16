import type {ModelMessage} from "@zhivex-ai/core";
/** Close transcript gaps from a terminal run; never replay an unrecorded tool effect. */
export function terminalContinuationMessages(messages:readonly ModelMessage[]):ModelMessage[]{
 const recorded=new Set(messages.flatMap(message=>message.parts.flatMap(part=>part.type==="tool-result"?[part.toolResult.toolCallId]:[])));
 return messages.flatMap(message=>{
  if(message.role!=="assistant")return [message];
  const missing=message.parts.filter(part=>part.type==="tool-call"&&!recorded.has(part.toolCall.id));
  if(!missing.length)return [message];
  return [message,{role:"tool" as const,parts:missing.map(part=>{
   if(part.type!=="tool-call")throw new Error("INVALID_CONTINUATION");
   return {type:"tool-result" as const,toolResult:{toolCallId:part.toolCall.id,toolName:part.toolCall.name,isError:true,output:{status:"outcome_unknown",reason:"Previous run ended without a recorded tool result. Inspect current state before any new proposal; do not assume execution or success."}}};
  })}];
 });
}
