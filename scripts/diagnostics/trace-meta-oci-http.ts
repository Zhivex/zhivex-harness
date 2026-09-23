/** Diagnostic preload for live-execution-smoke.ts. Raw bytes stay in memory.
 * Run with Bun --preload and select only meta with explicit live opt-in.
 * A receipt need not have an inline call when previous_response_id is present.
 */
if (process.env.ZHIVEX_HARNESS_LIVE !== "1" || process.env.ZHIVEX_HARNESS_LIVE_PROVIDERS !== "meta") {
  throw new Error("Meta-only explicit live opt-in required for HTTP diagnostics");
}
const original = globalThis.fetch;
let requestIndex = 0;
const seen = new Map<string, Set<string>>();
const pending: Promise<void>[] = [];
globalThis.fetch = Object.assign(async (...args: Parameters<typeof fetch>) => {
 await Promise.all(pending);
 const index = ++requestIndex;
 let request: any = {};
 try { request = JSON.parse(String(args[1]?.body ?? '{}')); } catch {}
 const items = Array.isArray(request.input) ? request.input : [];
 const calls = items.filter((x:any)=>x.type==='function_call');
 const receipts = items.filter((x:any)=>x.type==='function_call_output');
 const callIds = calls.map((x:any)=>x.call_id);
 const receiptIds = receipts.map((x:any)=>x.call_id);
 const priorCalls = seen.get(request.previous_response_id);
 console.error(JSON.stringify({diagnostic:'meta_continuation_identity',requestIndex:index,hasPrevious:!!request.previous_response_id,previousWasReturned:!!priorCalls,receiptCount:receiptIds.length,allReceiptsMatchReturnedCalls:!!priorCalls && receiptIds.every((id:any)=>priorCalls.has(id)),allReturnedCallsHaveReceipts:!!priorCalls && [...priorCalls].every(id=>receiptIds.includes(id))}));
 const response = await original(...args);
 if(response.ok) pending.push(response.clone().text().then(raw=>{
  let responseId: string | undefined; const ids = new Set<string>();
  for(const line of raw.split(/\r?\n/)) {
   if(!line.startsWith('data:') || line.slice(5).trim()==='[DONE]') continue;
   const event=JSON.parse(line.slice(5));
   if(event.type==='response.completed') {responseId=event.response?.id; for(const item of event.response?.output??[]) if(item.type==='function_call') ids.add(item.call_id??item.id);}
   if(event.type==='response.output_item.done' && event.item?.type==='function_call') ids.add(event.item.call_id??event.item.id);
  }
  if(responseId) seen.set(responseId,ids);
 }).catch(()=>{console.error(JSON.stringify({diagnostic:'capture_failed'}));}));
 console.error(JSON.stringify({diagnostic:'meta_request_shape',requestIndex:index,status:response.status,tools:request.tools?.length??0,calls:calls.length,receipts:receipts.length,duplicateCallIds:new Set(callIds).size!==callIds.length,duplicateReceiptIds:new Set(receiptIds).size!==receiptIds.length,receiptWithoutInlineCall:receiptIds.some((id:any)=>!callIds.includes(id)),missingReceipt:callIds.some((id:any)=>!receiptIds.includes(id)),hasPreviousResponseId:typeof request.previous_response_id==='string'}));
 if (!response.ok) {
  const text = await response.clone().text();
  let body: any = {};
  try { body = JSON.parse(String(args[1]?.body ?? '{}')); } catch {}
  const words = ['schema','additionalProperties','required','strict','tool','function','call_id','output','previous_response_id','unsupported','invalid','name','description','temperature','max_tokens','max_output_tokens'];
  const flags = Object.fromEntries(words.map(word=>[word,text.toLowerCase().includes(word.toLowerCase())]));
  const counts = Object.fromEntries(['function_call','function_call_output','message'].map(type=>[type,(body.input ?? []).filter((x:any)=>x.type===type).length]));
  console.error(JSON.stringify({diagnostic:'meta_http_rejection',requestIndex:index,status:response.status,flags,counts,toolCount:body.tools?.length ?? 0}));
 }
 return response;
}, {preconnect: original.preconnect});
