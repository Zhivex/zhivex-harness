import vm from 'node:vm';
import { isDeepStrictEqual } from 'node:util';

export function planJobs(jobs: {id:string;deps:string[];disabled?:boolean}[]) {
  const byId=new Map(jobs.map(j=>[j.id,j])), blocked=new Set<string>();
  for(const j of jobs) if(j.disabled || j.deps.some(d=>!byId.has(d))) blocked.add(j.id);
  let changed=true;
  while(changed){changed=false;for(const j of jobs)if(!blocked.has(j.id)&&j.deps.some(d=>blocked.has(d))){blocked.add(j.id);changed=true;}}
  const done=new Set<string>(), rounds:string[][]=[];
  while(true){const ready=jobs.filter(j=>!blocked.has(j.id)&&!done.has(j.id)&&j.deps.every(d=>done.has(d))).map(j=>j.id).sort();if(!ready.length)break;rounds.push(ready);ready.forEach(id=>done.add(id));}
  for(const j of jobs)if(!done.has(j.id))blocked.add(j.id);
  return {rounds,blocked:[...blocked].sort()};
}
export function settle(initial:Record<string,number>,events:{id:string;seq:number;from:string;to:string;amount:number}[],fee:number){
  const balances={...initial},seen=new Set<string>(),unique=events.filter(e=>{if(seen.has(e.id))return false;seen.add(e.id);return true;});
  unique.sort((a,b)=>a.seq-b.seq||(a.id<b.id?-1:a.id>b.id?1:0));
  const applied:string[]=[],rejected:string[]=[];let fees=0;
  for(const e of unique){if(!Object.hasOwn(balances,e.from)||!Object.hasOwn(balances,e.to)||e.from===e.to||!Number.isSafeInteger(e.amount)||e.amount<=0||balances[e.from]!<e.amount+fee){rejected.push(e.id);continue;} balances[e.from]!-=e.amount+fee;balances[e.to]!+=e.amount;fees+=fee;applied.push(e.id);}
  return {balances,applied,rejected,fees};
}
const common='Use pure JavaScript functions. Preserve inputs, including nested arrays and objects. No imports, I/O, eval, randomness or clock access. Return proposed code only; do not edit files.';
export const hardFixtures=[
 {id:'dependency-planner',name:'planJobs',files:{
  'src/planner.js':'export function planJobs(jobs) { return {rounds: [jobs.filter(j=>!j.disabled).map(j=>j.id)], blocked: []}; }',
  'docs/contract.md':'Input is an array of jobs with unique string ids, deps array of string ids, optional disabled. No malformed types. Return {rounds:string[][],blocked:string[]}. Disabled jobs and jobs referencing missing ids are blocked. Their downstream dependents are blocked transitively. Schedule all remaining jobs in simultaneous rounds: a job becomes ready only when every dependency completed in a PRIOR round. Sort ids within each round using code-unit ascending order, not locale order. Duplicate deps have no extra effect. Self cycles, multi-node cycles and their downstream dependents remain blocked. Independent acyclic components still run. Return every unscheduled job id exactly once, sorted, in blocked. Do not mutate any input, even nested deps arrays.',
  'src/example.json':'[{"id":"b","deps":["a"]},{"id":"a","deps":[]},{"id":"c","deps":["b"]}]',
  'tests/planner.test.js':'// Example must produce {rounds:[["a"],["b"],["c"]],blocked:[]} not a single round. Empty jobs produces empty rounds and blocked.',
  'src/AGENTS.md':common
 },paths:['src/planner.js','docs/contract.md','src/example.json','tests/planner.test.js']},
 {id:'transfer-ledger',name:'settle',files:{
  'src/ledger.js':'export function settle(initial,events,fee) { const balances={...initial}; for(const e of events) { balances[e.from]-=e.amount; balances[e.to]+=e.amount; } return {balances,applied:events.map(e=>e.id),rejected:[],fees:0}; }',
  'docs/contract.md':'initial maps ordinary account ids to nonnegative integer cents; fee is a nonnegative integer. Events have id(string), seq(integer), from/to(account ids), amount(number). Deduplicate by id BEFORE ordering, keeping the first occurrence in input even if later rejected; later duplicates are ignored and not rejected. Sort remaining events by seq ascending, tie by id using code-unit ascending comparison, not locale. Reject unknown accounts, same-account transfers, non-safe-integer or nonpositive amount, and insufficient sender balance for amount+fee. Rejection changes neither balances nor fees. Applied transfer debits sender by amount+fee, credits recipient by amount, and adds fee to fees. Return {balances,applied,rejected,fees}; applied/rejected contain ids in processing order. Do not mutate initial, events, or event objects. For empty events return unchanged balances and empty arrays. All account ids in fixtures are ordinary names, not prototype properties.',
  'src/example.json':'{"initial":{"a":10,"b":0},"events":[{"id":"x","seq":1,"from":"a","to":"b","amount":8}],"fee":2}',
  'tests/ledger.test.js':'// Example result: {balances:{a:0,b:8},applied:["x"],rejected:[],fees:2}. If amount=9, reject with both balances unchanged and fees=0.',
  'src/AGENTS.md':common
 },paths:['src/ledger.js','docs/contract.md','src/example.json','tests/ledger.test.js']}
] as const;
export const hardCases: Record<string,unknown[][]>={
 'dependency-planner':[
  [[]], [[{id:'a',deps:[]}]], [[{id:'b',deps:['a']},{id:'a',deps:[]},{id:'c',deps:['b']}]],
  [[{id:'a',deps:[],disabled:true},{id:'b',deps:['a']},{id:'c',deps:['b']},{id:'d',deps:[]}]],
  [[{id:'a',deps:['missing']},{id:'b',deps:['a']},{id:'c',deps:[]}]],
  [[{id:'a',deps:['a']},{id:'b',deps:[]}]], [[{id:'a',deps:['b']},{id:'b',deps:['a']},{id:'c',deps:['a']},{id:'d',deps:[]}]],
  [[{id:'z',deps:[]},{id:'A',deps:[]},{id:'a',deps:[]},{id:'x',deps:['z','A','a']}]],
  [[{id:'a',deps:[]},{id:'b',deps:['a','a']}]],
  [[{id:'a',deps:[]},{id:'b',deps:[]},{id:'c',deps:['a','b']},{id:'d',deps:['c']}]],
  [Array.from({length:18},(_,i)=>({id:String(i).padStart(2,'0'),deps:i?[String(i-1).padStart(2,'0')]:[]})).reverse()]
 ],
 'transfer-ledger':[
  [{a:10,b:0},[],2], [{a:10,b:0},[{id:'x',seq:1,from:'a',to:'b',amount:8}],2],
  [{a:10,b:0},[{id:'x',seq:1,from:'a',to:'b',amount:9}],2],
  [{a:10,b:0},[{id:'x',seq:2,from:'a',to:'b',amount:9},{id:'x',seq:1,from:'a',to:'b',amount:1}],2],
  [{a:10,b:0},[{id:'back',seq:2,from:'b',to:'a',amount:6},{id:'first',seq:1,from:'a',to:'b',amount:8}],2],
  [{a:10,b:0},[{id:'a',seq:1,from:'a',to:'b',amount:7},{id:'A',seq:1,from:'a',to:'b',amount:5}],0],
  [{a:10,b:0},[{id:'x',seq:1,from:'none',to:'a',amount:1},{id:'y',seq:2,from:'a',to:'none',amount:1}],1],
  [{a:10,b:0},[{id:'x',seq:1,from:'a',to:'a',amount:1}],1],
  [{a:10,b:0},[0,-1,1.5,9007199254740992].map((amount,seq)=>({id:String(seq),seq,from:'a',to:'b',amount})),1],
  [{a:10,b:0,c:0},[{id:'x',seq:0,from:'a',to:'b',amount:8},{id:'y',seq:1,from:'b',to:'c',amount:6},{id:'z',seq:2,from:'c',to:'a',amount:4}],2],
  [{a:10,b:0},[{id:'x',seq:1,from:'a',to:'b',amount:2},{id:'x',seq:0,from:'b',to:'a',amount:2},{id:'y',seq:2,from:'a',to:'b',amount:3}],1]
 ]
};
function oracle(id:string,args:any[]){return id==='dependency-planner'?planJobs(args[0]):settle(args[0],args[1],args[2]);}
function evaluate(code:string,name:string,args:unknown[]){
 const context=vm.createContext({}, {codeGeneration:{strings:false,wasm:false}});
 return JSON.parse(vm.runInContext(`'use strict'; ${code}; const args=${JSON.stringify(args)}; const before=JSON.stringify(args); const value=${name}(...args); JSON.stringify({value,unchanged:before===JSON.stringify(args)});`,context,{timeout:100}));
}
export function gradeHardAnswer(id:string,answer:string){
 const cases=hardCases[id]!,fixture=hardFixtures.find(f=>f.id===id)!;
 let format=false,words=0,passed=0,regressions=0;
 try{
  const p=JSON.parse(answer);
  format=JSON.stringify(Object.keys(p).sort())===JSON.stringify(['explanation','regressions','replacement'])&&typeof p.replacement==='string'&&typeof p.explanation==='string'&&Array.isArray(p.regressions)&&p.regressions.length===3;
  words=typeof p.explanation==='string'?p.explanation.trim().split(/\s+/).length:0;
  if(!format||p.replacement.length>16000)throw Error('format');
  for(const args of cases){try{const r=evaluate(p.replacement,fixture.name,args);if(r.unchanged&&isDeepStrictEqual(r.value,oracle(id,args)))passed++;}catch{}}
  const unique=new Set<string>();
  for(const t of p.regressions){try{if(!Array.isArray(t.args)||typeof t.name!=='string'||!t.name||unique.has(JSON.stringify(t.args)))continue;unique.add(JSON.stringify(t.args));const r=evaluate(p.replacement,fixture.name,t.args);const buggy=evaluate(Object.values(fixture.files)[0]!.replace('export ',''),fixture.name,t.args);if(r.unchanged&&isDeepStrictEqual(r.value,t.expected)&&isDeepStrictEqual(t.expected,oracle(id,t.args))&&!isDeepStrictEqual(buggy.value,t.expected))regressions++;}catch{}}
 }catch{}
 const facts=passed===cases.length,length=words>=120&&words<=160;
 return {format,facts,words,length,tests:cases.length,passed,regressions,pass:format&&facts&&length&&regressions===3};
}
