import vm from 'node:vm';
export const repositoryFixtures = [
  { id: 'invoice', files: {
    'src/invoice.js': 'export function summarize(items, config) { const subtotal = items.reduce((s,i)=>s+i.cents*i.qty,0); return {subtotal,discount:Math.round(subtotal*config.discountBps/10000),shipping:config.shippingCents,total:subtotal+config.shippingCents}; }\n',
    'src/config.json': '{"discountBps":1250,"freeShippingAt":10000,"shippingCents":700}',
    'docs/billing.md': 'All amounts are integer cents. Ignore cancelled rows. subtotal = sum(cents * qty) of active rows. discount = floor(subtotal * discountBps / 10000). net = subtotal - discount. Shipping is zero when net >= freeShippingAt, otherwise shippingCents. If there are no active rows, every result field is zero. Return subtotal, discount, shipping, total = net + shipping. Do not mutate input rows.\n',
    'tests/invoice.test.js': 'const items=[{cents:5000,qty:2},{cents:999,qty:1,cancelled:true}]; // subtotal 10000, discount 1250, shipping 700, total 9450\n',
    'src/AGENTS.md': 'Preserve the function name and arguments. Pure functions only. No imports, network or filesystem operations in replacements. Do not edit files for a review.\n'
  }, paths: ['src/invoice.js','src/config.json','docs/billing.md','tests/invoice.test.js'],
  task: 'Diagnose the invoice implementation using config, billing contract and test. Return JSON with replacement (a standalone JavaScript function declaration named summarize, no export/import) and explanation (80-100 words). The replacement must fix all contract defects, handle empty/cancelled rows and arbitrary supplied config, and preserve inputs.',
  functionName: 'summarize' },
  { id: 'pagination', files: {
    'src/page.js': 'export function page(rows, tenant, offset, limit) { return rows.slice(offset,offset+limit).filter(r=>r.tenant===tenant && !r.deleted).sort((a,b)=>a.created-b.created).map(r=>r.id); }\n',
    'src/example.json': '[{"id":"b","tenant":"red","created":2},{"id":"a","tenant":"blue","created":1},{"id":"c","tenant":"red","created":1},{"id":"d","tenant":"red","created":2}]',
    'docs/paging.md': 'First select exact tenant matches and exclude deleted rows. Then order by created ascending, breaking ties by id in ascending code-unit lexicographic order. Then apply offset/limit and return ids. Clamp negative integer offset and limit to zero. Never mutate rows or array. Zero limit returns empty. Offset beyond length returns empty. No locale-dependent ordering.\n',
    'tests/page.test.js': '// page(example,"red",1,2) must return ["b","d"]. Filtering after pagination loses tenant rows. Equal timestamps must have deterministic id order.\n',
    'src/AGENTS.md': 'Preserve function name and arguments. Pure functions only; no imports. This is a read-only review; return proposed code without editing files.\n'
  }, paths: ['src/page.js','src/example.json','docs/paging.md','tests/page.test.js'],
  task: 'Review the pagination implementation against all repository contracts and examples. Return JSON with replacement (a standalone JavaScript function declaration named page, no export/import) and explanation (80-100 words). Correct tenant filtering, ordering, pagination and edge cases without mutating inputs.',
  functionName: 'page' }
] as const;
export function gradeRepositoryAnswer(id: string, answer: string) {
  let format = false, words = 0, tests = 0, passed = 0;
  try {
    const fixture = repositoryFixtures.find(f => f.id === id)!;
    const parsed = JSON.parse(answer);
    format = JSON.stringify(Object.keys(parsed).sort()) === JSON.stringify(['explanation','replacement']) && typeof parsed.replacement === 'string' && typeof parsed.explanation === 'string';
    words = typeof parsed.explanation === 'string' ? parsed.explanation.trim().split(/\s+/).length : 0;
    if (!format || parsed.replacement.length > 8000) throw new Error('format');
    const cases = id === 'invoice' ? [
      [[], {discountBps:1250,freeShippingAt:10000,shippingCents:700}],
      [[{cents:5000,qty:2},{cents:999,qty:1,cancelled:true}],{discountBps:1250,freeShippingAt:10000,shippingCents:700}],
      [[{cents:101,qty:3}],{discountBps:1500,freeShippingAt:10000,shippingCents:700}],
      [[{cents:12000,qty:1}],{discountBps:1250,freeShippingAt:10000,shippingCents:700}],
      [[{cents:1,qty:1,cancelled:true}],{discountBps:0,freeShippingAt:0,shippingCents:500}],
      [[{cents:10000,qty:1}],{discountBps:0,freeShippingAt:10000,shippingCents:600}]
    ] : Array.from({length:8},(_,i)=> [[{id:'z',tenant:'red',created:2},{id:'A',tenant:'red',created:2},{id:'a',tenant:'red',created:2},{id:'c',tenant:'red',created:1},{id:'x',tenant:'blue',created:0},{id:'d',tenant:'red',created:0,deleted:true}], i===7?'missing':'red', [0,1,0,-1,20,0,2,0][i], [4,2,0,2,5,-2,1,4][i]]);
    tests = cases.length;
    for (const args of cases) {
      const context = vm.createContext({}, {codeGeneration:{strings:false,wasm:false}});
      const result = vm.runInContext(`'use strict'; ${parsed.replacement}; const args=${JSON.stringify(args)}; const before=JSON.stringify(args); const value=${fixture.functionName}(...args); JSON.stringify({value,unchanged:before===JSON.stringify(args)});`, context, {timeout:100});
      const observed=JSON.parse(result);
      let expected;
      if(id==='invoice') {
        const [rows,config]=args as [any[],any]; const active=rows.filter(r=>!r.cancelled); const subtotal=active.reduce((s,r)=>s+r.cents*r.qty,0);
        const discount=Math.floor(subtotal*config.discountBps/10000); const shipping=active.length && subtotal-discount<config.freeShippingAt?config.shippingCents:0;
        expected={subtotal,discount,shipping,total:subtotal-discount+shipping};
      } else { const [rows,tenant,offset,limit]=args as [any[],string,number,number]; expected=rows.filter(r=>r.tenant===tenant&&!r.deleted).sort((a,b)=>a.created-b.created||(a.id<b.id?-1:a.id>b.id?1:0)).slice(Math.max(0,offset),Math.max(0,offset)+Math.max(0,limit)).map(r=>r.id); }
      const equal=id==='invoice' ? Object.keys(expected).length===Object.keys(observed.value).length && Object.entries(expected).every(([k,v])=>observed.value[k]===v) : JSON.stringify(expected)===JSON.stringify(observed.value);
      if(equal&&observed.unchanged) passed++;
    }
  } catch { /* All errors are a failed candidate, never a campaign retry. */ }
  const facts=tests>0&&passed===tests, length=words>=80&&words<=100;
  return {format,facts,words,length,pass:format&&facts&&length,tests,passed};
}
