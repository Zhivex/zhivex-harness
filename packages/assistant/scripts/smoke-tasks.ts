import assert from 'node:assert/strict';
import {writeFile,readFile} from 'node:fs/promises';
import {execFileSync} from 'node:child_process';
import {chromium} from 'playwright';
import {tasksFixture} from './tasks-fixture.js';
const app=await tasksFixture(),browser=await chromium.launch({headless:true});
try{
 const page=await browser.newPage({viewport:{width:1440,height:1000}}),errors:string[]=[];page.on('pageerror',e=>errors.push(e.message));await page.goto(app.url);await page.getByRole('button',{name:'Proyectos',exact:true}).click();
 await page.getByText('Tareas aisladas',{exact:true}).click();await page.getByLabel('Título de tarea').fill('Task One');await page.getByLabel('Entiendo que mis cambios locales del origen quedan fuera.').check();await page.getByRole('button',{name:'Crear tarea aislada',exact:true}).click();await page.getByRole('heading',{name:'Task One',exact:true}).waitFor();
 const tasks=await app.app.taskAction({action:'list'}) as {tasks:{id:string;workspace:string;projectKey:string}[]};const task=tasks.tasks[0]!;assert.equal(await readFile(task.workspace+'/note.txt','utf8'),'base\n');await writeFile(task.workspace+'/note.txt','task result\n');
 await page.getByText('Entrega con Git',{exact:true}).click();await page.getByRole('button',{name:'Actualizar cambios',exact:true}).click();await page.getByLabel('note.txt · sin stage · cambios locales',{exact:true}).check();await page.getByRole('button',{name:'Stage de archivos seleccionados',exact:true}).click();await page.getByLabel('Mensaje de commit',{exact:true}).fill('Reviewed task result');await page.getByRole('button',{name:'Revisar commit',exact:true}).click();await page.getByRole('region',{name:'Revisión de entrega'}).waitFor();await page.getByLabel('Revisé el contenido y el destino de esta operación.').check();
 let dropped=false;await page.route('**/api/workspace/tasks',async route=>{const data=route.request().postDataJSON();if(data.action==='commit'&&!dropped){dropped=true;await route.fetch();await route.abort();}else await route.continue();});
 await page.getByRole('button',{name:'Confirmar commit',exact:true}).click();await page.getByRole('alert').filter({hasText:/conectar con el servicio local/i}).waitFor();await page.getByRole('button',{name:'Reconciliar resultado',exact:true}).click();await page.getByRole('status').filter({hasText:'completed'}).waitFor();assert.equal(execFileSync('git',['-C',task.workspace,'rev-list','--count','HEAD'],{encoding:'utf8'}).trim(),'2');assert.equal(await readFile(app.repo+'/note.txt','utf8'),'source dirty\n');
 await page.getByText('Tareas aisladas',{exact:true}).click();await page.getByRole('button',{name:'Revisar eliminación',exact:true}).click();await page.getByRole('region',{name:'Revisión de eliminación'}).waitFor();assert.equal(await page.getByRole('button',{name:'Eliminar worktree revisado',exact:true}).isEnabled(),false);
 await page.getByRole('button',{name:'Cerrar revisión',exact:true}).click();await page.getByRole('button',{name:'Cerrar entorno inactivo',exact:true}).click();await page.getByRole('heading',{name:'sample-project',exact:true}).waitFor();
 await page.setViewportSize({width:390,height:844});assert.equal(await page.evaluate('document.documentElement.scrollWidth > innerWidth'),false);assert.deepEqual(errors,[]);
 console.log('Task/Git browser smoke passed: committed-HEAD task, source changes excluded, reviewed local commit, lost-response reconciliation without duplicate commit, removal blocked for unintegrated work, mobile layout.');
}finally{await browser.close();await app.close();}
