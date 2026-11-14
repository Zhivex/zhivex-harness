import { test, expect } from 'bun:test';
import { gradeRepositoryAnswer, repositoryFixtures } from '../scripts/benchmarks/repository-preload-fixtures.js';
const explanation = Array(85).fill('word').join(' ');
test('repository grading rejects original bugs and accepts complete nonmutating fixes', () => {
  for (const fixture of repositoryFixtures) {
    const original = Object.values(fixture.files)[0]!.replace('export ', '');
    expect(gradeRepositoryAnswer(fixture.id, JSON.stringify({replacement:original,explanation})).facts).toBe(false);
  }
  const invoice='function summarize(items,c){const a=items.filter(i=>!i.cancelled);const subtotal=a.reduce((s,i)=>s+i.cents*i.qty,0);const discount=Math.floor(subtotal*c.discountBps/10000);const shipping=a.length&&subtotal-discount<c.freeShippingAt?c.shippingCents:0;return {subtotal,discount,shipping,total:subtotal-discount+shipping};}';
  const page='function page(rows,tenant,offset,limit){offset=Math.max(0,offset);limit=Math.max(0,limit);return rows.filter(r=>r.tenant===tenant&&!r.deleted).sort((a,b)=>a.created-b.created||(a.id<b.id?-1:a.id>b.id?1:0)).slice(offset,offset+limit).map(r=>r.id);}';
  expect(gradeRepositoryAnswer('invoice',JSON.stringify({replacement:invoice,explanation}))).toMatchObject({pass:true,tests:6,passed:6});
  expect(gradeRepositoryAnswer('pagination',JSON.stringify({replacement:page,explanation}))).toMatchObject({pass:true,tests:8,passed:8});
  expect(gradeRepositoryAnswer('pagination',JSON.stringify({replacement:'function page(){while(true){}}',explanation})).facts).toBe(false);
});
