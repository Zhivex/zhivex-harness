import {test,expect} from 'bun:test';
import {citeResponseText} from '../src/providers/web-citations.js';

test('citations reject unsafe URLs and invalid offsets, and encodes link delimiters',()=>{
  const text='Actual [1]';
  const response=(url:string,start=7,end=10)=>({output:[{type:'message',content:[{type:'output_text',text,annotations:[{type:'url_citation',start_index:start,end_index:end,url,title:'Source'}]}]}]});
  for(const url of ['javascript:alert(1)','https://user:password@example.test','not a URL'])expect(citeResponseText(text,response(url))).toBe(text);
  expect(citeResponseText(text,response('https://example.test',-1,10))).toBe(text);
  expect(citeResponseText(text,response('https://example.test',7,100))).toBe(text);
  const cited=citeResponseText(text,response('https://example.test/weather(1)'));
  expect(cited).toBe('Actual [Source](https://example.test/weather%281%29)');
});
