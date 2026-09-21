const {app,BrowserWindow,ipcMain}=require('electron');
const fs=require('node:fs'); const path=require('node:path'); const assert=require('node:assert/strict');
const build=process.argv[2],report=process.argv[3]; app.setPath('userData',path.join(report,'profile'));
app.whenReady().then(async()=>{
 let calls=0,downloads=0,installs=0,state={status:'idle'};
 ipcMain.handle('harness:initial-project',()=>null); ipcMain.handle('harness:projects',()=>[]);
 ipcMain.handle('harness:update-status',()=>state);
 ipcMain.handle('harness:check-updates',async()=>{calls++;state={status:'checking'};await new Promise(r=>setTimeout(r,50));return state=[{status:'available',version:'1.1.0',channel:'stable'},{status:'failed'},{status:'current'},{status:'unconfigured'}][calls-1];});
 ipcMain.handle('harness:download-update',async()=>{downloads++;state={status:'downloading',version:'1.1.0',channel:'stable'};await new Promise(r=>setTimeout(r,downloads===2?1500:100));return state={status:downloads===1?'download-failed':'downloaded',version:'1.1.0',channel:'stable'};});
 ipcMain.handle('harness:install-update',async()=>{installs++;state={status:'installing',version:'1.1.0',channel:'stable'};await new Promise(r=>setTimeout(r,100));return state={status:installs===1?'work-active':'install-failed',version:'1.1.0',channel:'stable'};});
 const w=new BrowserWindow({width:720,height:760,show:false,webPreferences:{preload:path.join(build,'preload.cjs'),contextIsolation:true,nodeIntegration:false,sandbox:true}});
 await w.loadFile(path.join(build,'index.html')); const js=source=>w.webContents.executeJavaScript(source);
 const wait=async(expression)=>{for(let i=0;i<100;i++){if(await js(expression))return;await new Promise(r=>setTimeout(r,20));}throw Error('UPDATE_UI_TIMEOUT');};
 await wait('!document.querySelector("[data-action=check-updates]").disabled');
 await js('document.querySelector(".update-settings").open=true;document.querySelector("[data-action=check-updates]").click();document.querySelector("[data-action=check-updates]").click()');
 await wait('document.querySelector(".update-settings").textContent.includes("Disponible: 1.1.0")'); assert.equal(calls,1);
 await js('document.querySelector("[data-action=download-update]").click();document.querySelector("[data-action=download-update]")?.click()');
 await wait('document.querySelector(".update-settings").textContent.includes("No se pudo completar la descarga")'); assert.equal(downloads,1);
 await js('document.querySelector("[data-action=download-update]").click()');
 await wait('document.querySelector(".update-settings").textContent.includes("Descargando")');
 await w.loadFile(path.join(build,'index.html'));
 await wait('document.querySelector(".update-settings").textContent.includes("Descarga verificada")'); assert.equal(downloads,2);
 await js('document.querySelector(".update-settings").open=true;document.querySelector(".update-settings").scrollIntoView({block:"nearest"})');
 await js('new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))');
 fs.writeFileSync(path.join(report,'downloaded.png'),(await w.webContents.capturePage()).toPNG());
 for(const text of ['Hay trabajo activo','No se pudo preparar la instalación']) {await js('document.querySelector("[data-action=install-update]").click();document.querySelector("[data-action=install-update]")?.click()');await wait(`document.querySelector('.update-settings').textContent.includes(${JSON.stringify(text)})`);}
 assert.equal(installs,2);
 for(const text of ['No se pudo verificar','Tenés la versión más reciente','todavía no están habilitadas']){await js('document.querySelector("[data-action=check-updates]").click()');await wait(`document.querySelector('.update-settings').textContent.includes(${JSON.stringify(text)})`);}
 assert(await js('document.querySelector("[data-action=check-updates]").disabled'));
 assert(await js('document.querySelector("aside").contains(document.querySelector(".update-settings")) && document.querySelector("main").children.length===2'));
 await js('document.querySelector(".update-settings").scrollIntoView({block:"nearest"})');
 fs.writeFileSync(path.join(report,'updates.png'),(await w.webContents.capturePage()).toPNG());
 fs.writeFileSync(path.join(report,'report.json'),JSON.stringify({fixtureBackend:true,available:true,downloadRetry:true,downloaded:true,installationRetry:true,activeWorkMessage:true,reloadDuringDownload:true,failureRecovery:true,current:true,unconfigured:true,duplicateClickPrevented:true,sidebarPlacement:true,pass:true},null,2));app.exit(0);
}).catch(()=>{console.error('UPDATE_UI_FAILED');app.exit(1);});
