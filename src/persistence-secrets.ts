/** Process-private protection enabled by trusted hosts before opening persistence. */
const protectedValues=new Set<string>();
export function protectPersistenceSecret(secret:string):void {
 if(!secret)return;
 protectedValues.add(secret);
 // JSON fields may contain escaped quotes/backslashes rather than the literal value.
 protectedValues.add(JSON.stringify(secret).slice(1,-1));
}
export function assertNoPersistenceSecret(value:unknown):void {
 if(!protectedValues.size)return;
 const seen=new WeakSet<object>();
 const visit=(item:unknown):void=>{
  if(typeof item==="string"){for(const secret of protectedValues)if(item.includes(secret))throw new Error("PERSISTENCE_SECRET_REJECTED");}
  else if(item instanceof Uint8Array){const bytes=Buffer.from(item.buffer,item.byteOffset,item.byteLength);for(const secret of protectedValues)if(bytes.includes(Buffer.from(secret)))throw new Error("PERSISTENCE_SECRET_REJECTED");}
  else if(item&&typeof item==="object"&&!seen.has(item)){seen.add(item);for(const [key,entry] of Object.entries(item)){visit(key);visit(entry);}}
 };
 visit(value);
}
