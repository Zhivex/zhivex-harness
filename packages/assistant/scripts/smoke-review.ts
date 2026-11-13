import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { chromium } from 'playwright';
import { reviewFixture } from './review-fixture.js';
const fixture=await reviewFixture();const browser=await chromium.launch({headless:true});
try {
 const page=await browser.newPage({viewport:{width:1500,height:1100}});const errors:string[]=[];page.on('pageerror',e=>errors.push(e.message));
 await page.goto(fixture.url);await page.getByRole('button',{name:'Proyectos',exact:true}).click();await page.getByRole('button',{name:'Conversación 1',exact:true}).click();
 await page.getByText('Aprobaciones, cambios y recuperación',{exact:true}).click();
 const inspect=page.getByRole('button',{name:'Revisar aprobación',exact:true});await inspect.click();
 await page.getByRole('region',{name:'Diff del archivo'}).waitFor();
 await page.getByLabel('Revisé todos los archivos, comandos y efectos mostrados.').check();{ const response=page.waitForResponse(r=>r.url().endsWith('/api/workspace/decision')); await page.getByRole('button',{name:'Autorizar ejecución',exact:true}).click(); assert.equal((await response).status(),200); }
 await page.getByRole('button',{name:'Autorizar ejecución',exact:true}).waitFor({state:'hidden'});assert.equal(await readFile(fixture.repo+'/note.txt','utf8'),'after\n');
 await inspect.click();await page.getByText('node -e "console.log(123)"',{exact:true}).waitFor();await page.getByLabel('Revisé todos los archivos, comandos y efectos mostrados.').check();{ const response=page.waitForResponse(r=>r.url().endsWith('/api/workspace/decision')); await page.getByRole('button',{name:'Autorizar ejecución',exact:true}).click(); assert.equal((await response).status(),200); }
 await page.getByText('Edited and checked.',{exact:true}).waitFor();
 await page.getByRole('button',{name:'Actualizar cambios e historial',exact:true}).click();await page.getByRole('region',{name:'Historial de decisiones'}).getByRole('region',{name:'Diff del archivo'}).waitFor();
 await page.screenshot({path:'/tmp/tauri-stage3/review-desktop.png',fullPage:true});
 const followup=await fixture.cli(['run','Follow up from Code']);assert.match(followup,/completed/);await page.getByText('Follow-up complete.',{exact:true}).waitFor();
 await page.getByRole('button',{name:'Workspace checkpoints',exact:true}).click();await page.getByRole('button',{name:'Prepare restore review',exact:true}).click();await page.getByLabel('I reviewed this operation and its effects.').check();{ const response=page.waitForResponse(r=>r.url().endsWith('/api/workspace/decision')); await page.getByRole('button',{name:'Confirm restoration',exact:true}).click(); assert.equal((await response).status(),200); }
 await page.getByRole('button',{name:'Open restored conversation',exact:true}).waitFor();assert.equal(await readFile(fixture.repo+'/note.txt','utf8'),'before\n');
 await page.screenshot({path:'/tmp/tauri-stage3/restore-desktop.png',fullPage:true});
 await page.getByRole('button',{name:'Open restored conversation',exact:true}).click();await page.getByText('Aprobaciones, cambios y recuperación',{exact:true}).waitFor();
 await page.getByText('Aprobaciones, cambios y recuperación',{exact:true}).click();
 await page.getByText('Tarea con checks y aceptación de entrega',{exact:true}).click();
 await page.getByLabel('Objetivo',{exact:true}).fill('Validate note delivery');await page.getByLabel('Archivos de la tarea, uno por línea').fill('note.txt');
 { const response=page.waitForResponse(r=>r.url().endsWith('/api/workspace/review-action')); await page.getByRole('button',{name:'Iniciar tarea revisable'}).click();const body=await (await response).json();assert.equal(body.ok,true,JSON.stringify(body)); }
 await page.getByText('Aprobaciones, cambios y recuperación',{exact:true}).click();
 await inspect.click();await page.getByLabel('Revisé todos los archivos, comandos y efectos mostrados.').check();
 {const response=page.waitForResponse(r=>r.url().endsWith('/api/workspace/decision'));await page.getByRole('button',{name:'Autorizar ejecución',exact:true}).click();assert.equal((await response).status(),200);}
 await page.getByText('Task checked.',{exact:true}).waitFor();await page.getByText('Tarea con checks y aceptación de entrega',{exact:true}).click();await page.getByRole('button',{name:'Revisar entrega y vigencia de checks'}).click();
 await page.getByText('check-1: confirmed',{exact:true}).waitFor();await page.getByLabel('Revisé la entrega y sus checks.').check();
 {const response=page.waitForResponse(r=>r.url().endsWith('/api/workspace/review-action'));await page.getByRole('button',{name:'Aceptar entrega',exact:true}).click();assert.equal((await (await response).json()).ok,true);}
 await page.getByRole('button',{name:'Revisar entrega y vigencia de checks'}).click();await page.getByText('Contenido: current · Aceptación: current',{exact:true}).waitFor();
 await page.screenshot({path:'/tmp/tauri-stage3/task-acceptance.png',fullPage:true});
 await writeFile(fixture.repo+'/note.txt','external edit\n');await page.getByRole('button',{name:'Revisar entrega y vigencia de checks'}).click();await page.getByText('Contenido: stale · Aceptación: stale',{exact:true}).waitFor();assert.equal(await page.getByRole('button',{name:'Aceptar entrega',exact:true}).isDisabled(),true);
 await page.setViewportSize({width:390,height:844});await page.waitForFunction((element:any)=>element.getBoundingClientRect().right<=0,await page.locator('.sidebar').elementHandle());assert.equal(await page.evaluate('document.documentElement.scrollWidth > innerWidth'),false);await page.screenshot({path:'/tmp/tauri-stage3/review-mobile.png',fullPage:true});
 assert.deepEqual(errors,[]);console.log('Stage 3 browser smoke passed: Code start, HTTP review/edit/check, saved diff, Code continuation, checkpoint restore, derived conversation, task acceptance and stale evidence rejection.');
}finally{await browser.close();await fixture.close();}
