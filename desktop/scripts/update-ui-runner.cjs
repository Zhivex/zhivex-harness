const {app,BrowserWindow,ipcMain}=require('electron');
const fs=require('node:fs'); const path=require('node:path'); const assert=require('node:assert/strict');
const build=process.argv[2],report=process.argv[3]; app.setPath('userData',path.join(report,'profile'));
app.whenReady().then(async()=>{
 let calls=0;
 ipcMain.handle('harness:initial-project',()=>null); ipcMain.handle('harness:projects',()=>[]);
 ipcMain.handle('harness:update-status',()=>({status:'idle'}));
 ipcMain.handle('harness:check-updates',async()=>{calls++;await new Promise(r=>setTimeout(r,50));return [{status:'available',version:'1.1.0',channel:'stable'},{status:'failed'},{status:'current'},{status:'unconfigured'}][calls-1];});
 const w=new BrowserWindow({width:720,height:760,show:false,webPreferences:{preload:path.join(build,'preload.cjs'),contextIsolation:true,nodeIntegration:false,sandbox:true}});
 await w.loadFile(path.join(build,'index.html')); const js=source=>w.webContents.executeJavaScript(source);
 const wait=async(expression)=>{for(let i=0;i<100;i++){if(await js(expression))return;await new Promise(r=>setTimeout(r,20));}throw Error('UPDATE_UI_TIMEOUT');};
 await wait('!document.querySelector("[data-action=check-updates]").disabled');
 await js('document.querySelector(".update-settings").open=true;document.querySelector("[data-action=check-updates]").click();document.querySelector("[data-action=check-updates]").click()');
 await wait('document.querySelector(".update-settings").textContent.includes("Disponible: 1.1.0")'); assert.equal(calls,1);
 for(const text of ['No se pudo verificar','Tenés la versión más reciente','todavía no están habilitadas']){await js('document.querySelector("[data-action=check-updates]").click()');await wait(`document.querySelector('.update-settings').textContent.includes(${JSON.stringify(text)})`);}
 assert(await js('document.querySelector("[data-action=check-updates]").disabled'));
 assert(await js('document.querySelector("aside").contains(document.querySelector(".update-settings")) && document.querySelector("main").children.length===2'));
 await js('document.querySelector(".update-settings").scrollIntoView({block:"nearest"})');
 fs.writeFileSync(path.join(report,'updates.png'),(await w.webContents.capturePage()).toPNG());
 fs.writeFileSync(path.join(report,'report.json'),JSON.stringify({fixtureBackend:true,available:true,failureRecovery:true,current:true,unconfigured:true,duplicateClickPrevented:true,sidebarPlacement:true,pass:true},null,2));app.exit(0);
}).catch(()=>{console.error('UPDATE_UI_FAILED');app.exit(1);});
