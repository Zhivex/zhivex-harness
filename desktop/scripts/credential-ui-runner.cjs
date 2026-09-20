const {app,BrowserWindow,ipcMain}=require('electron');const fs=require('node:fs');const path=require('node:path');
const build=process.argv[2],report=process.argv[3];app.setPath('userData',path.join(report,'profile'));
app.whenReady().then(async()=>{
 let present=false,locked=false,configureCalls=0,probeCalls=0;
 ipcMain.handle('harness:initial-project',()=>null);ipcMain.handle('harness:projects',()=>[]);
 ipcMain.handle('harness:credential-status',()=>locked?'locked':present?'present':'missing');
 ipcMain.handle('harness:credential-configure',()=>{configureCalls++;if(configureCalls===1)return 'cancelled';present=true;return 'saved';});
 ipcMain.handle('harness:credential-probe',()=>++probeCalls===1?'invalid-credential':'connected');
 ipcMain.handle('harness:credential-delete',()=>{present=false;return 'deleted';});
 const window=new BrowserWindow({width:1120,height:760,show:false,webPreferences:{preload:path.join(build,'preload.cjs'),contextIsolation:true,nodeIntegration:false,sandbox:true}});await window.loadFile(path.join(build,'index.html'));
 const js=code=>window.webContents.executeJavaScript(code);await js('document.querySelector(".credential-settings").open=true');
 const action=async(name,expected)=>{await js(`document.querySelector('[data-action="credential-${name}"]').click()`);for(let i=0;i<100;i++){if(await js(`document.querySelector('.credential-settings [role=status]')?.textContent.includes(${JSON.stringify(expected)}) && !document.querySelector('[data-action="credential-status"]').disabled`))return;await new Promise(r=>setTimeout(r,20));}throw Error('CREDENTIAL_UI_'+name);};
 await action('status','No hay');await action('configure','cancelada');await action('status','No hay');await action('configure','guardada');await action('status','guardada');await action('probe','rechazó');await action('configure','guardada');await action('probe','Conexión autorizada');locked=true;await action('status','Desbloqueá');locked=false;await action('status','guardada');await action('delete','eliminada');await action('status','No hay');
 const isolated=await js(`!document.querySelector('.credential-settings input,.credential-settings textarea') && !Object.keys(window.harness).some(key=>/read.*credential|credential.*read/i.test(key)) && localStorage.length===0 && typeof require==='undefined'`);if(!isolated)throw Error('CREDENTIAL_RENDERER_ISOLATION');
 const evidence={packagedRenderer:build.includes('app.asar'),fixtureBackend:true,nativeKeychain:false,missing:true,cancelPreserves:true,saveAndRotate:true,invalidCredentialRecovery:true,lockedRecovery:true,delete:true,noSecretInputOrReadBridge:true,noRendererStorage:true};fs.writeFileSync(path.join(report,'report.json'),JSON.stringify(evidence,null,2));fs.writeFileSync(path.join(report,'credentials.png'),(await window.webContents.capturePage()).toPNG());app.exit(0);
}).catch(error=>{console.error(error);app.exit(1)});
