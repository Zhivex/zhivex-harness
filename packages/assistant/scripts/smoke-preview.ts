import assert from 'node:assert/strict';
import {mkdir,writeFile} from 'node:fs/promises';
import {chromium} from 'playwright';
import {tasksFixture} from './tasks-fixture.js';
const f=await tasksFixture(),browser=await chromium.launch({headless:true});
try{
 await mkdir(f.repo+'/dist');await writeFile(f.repo+'/dist/index.html','<!doctype html><h1>Updated preview</h1>');
 const page=await browser.newPage({viewport:{width:1440,height:1000}}),errors:string[]=[];page.on('pageerror',e=>errors.push(e.message));
 await page.goto(f.url);await page.getByRole('button',{name:'Proyectos',exact:true}).click();
 const panel=page.getByRole('region',{name:'Previews y evidencia',exact:true});
 await panel.getByRole('button',{name:'Revisar preview',exact:true}).click();await panel.getByRole('region',{name:'Revisión de preview'}).waitFor();
 assert.equal(await panel.getByRole('button',{name:'Iniciar preview',exact:true}).isEnabled(),false);
 await panel.getByLabel('Revisé los archivos y autorizo esta publicación local').check();await panel.getByRole('button',{name:'Iniciar preview',exact:true}).click();
 await panel.getByLabel('Texto esperado',{exact:true}).fill('Updated preview');await panel.getByRole('button',{name:'Revisar verificación',exact:true}).click();
 assert.equal(await panel.getByRole('button',{name:'Verificar y guardar evidencia',exact:true}).isEnabled(),false);
 await panel.getByLabel('Autorizo este recorrido y guardar su captura').check();await panel.getByRole('button',{name:'Verificar y guardar evidencia',exact:true}).click();
 const evidence=panel.getByRole('button',{name:/Verificado.*Coincide/});await evidence.waitFor();await evidence.click();await panel.getByRole('img',{name:'Captura del recorrido verificado'}).waitFor();
 await panel.getByLabel('Comentario sobre esta evidencia').fill('Review the heading spacing');await panel.getByRole('button',{name:'Guardar comentario vinculado',exact:true}).click();await panel.getByRole('button',{name:/Comentario.*Coincide/}).waitFor();
 await writeFile(f.repo+'/dist/index.html','<!doctype html><h1>Changed after test</h1>');await panel.getByRole('button',{name:/Verificado.*Desactualizado/}).waitFor({timeout:15000});
 await page.setViewportSize({width:390,height:844});assert.equal(await page.evaluate('document.documentElement.scrollWidth > innerWidth'),false);
 await panel.getByRole('button',{name:'Detener previews',exact:true}).click();await panel.getByRole('button',{name:'Revisar preview',exact:true}).waitFor();assert.deepEqual(errors,[]);
 console.log('Preview UI smoke passed: separate publication/browser approvals, screenshot, anchored feedback, stale evidence and mobile layout.');
}finally{await browser.close();await f.close();}
