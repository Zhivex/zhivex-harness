import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {access} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {chromium} from 'playwright';
const exec=promisify(execFile);
export async function pilotDiagnostics(){
 const checks:{id:string;status:'available'|'missing'|'unverified';required:boolean;detail:string}[]=[];
 const platform=process.platform==='darwin'&&process.arch==='arm64';
 checks.push({id:'platform',status:platform?'available':'missing',required:true,detail:platform?'Piloto local para macOS Apple Silicon.':'Este piloto nativo solo está validado en macOS Apple Silicon; Intel, Windows y Linux siguen sin soporte.'});
 try{await exec('git',['--version'],{cwd:tmpdir(),timeout:3000,maxBuffer:1024,env:{PATH:process.env.PATH??'/usr/bin:/bin'}});checks.push({id:'git',status:'available',required:true,detail:'Git disponible. Las operaciones siguen sujetas a revisión.'});}catch{checks.push({id:'git',status:'missing',required:true,detail:'Instalá Git o las Command Line Tools de Apple y reiniciá Assistant.'});}
 try{const {AsyncEntry}=await import('@napi-rs/keyring');if(!AsyncEntry)throw Error();checks.push({id:'keychain',status:'unverified',required:true,detail:'Adaptador de llavero disponible. Conectar un modelo prueba el acceso real; no hay respaldo de claves en texto plano.'});}catch{checks.push({id:'keychain',status:'missing',required:true,detail:'Falta el adaptador nativo del llavero. Reinstalá el bundle para esta arquitectura.'});}
 try{await access(chromium.executablePath());checks.push({id:'browser',status:'available',required:false,detail:'Chromium instalado para esta versión de Playwright. Una verificación prueba su ejecución.'});}catch{checks.push({id:'browser',status:'missing',required:false,detail:'Para previews, ejecutá el Node del bundle con node_modules/playwright/cli.js install chromium. No se descarga automáticamente.'});}
 checks.push({id:'provider',status:'unverified',required:true,detail:'Conectá y probá un proveedor con permisos para el modelo y cuota disponible. Tener una clave guardada no demuestra acceso.'});
 checks.push({id:'execution',status:'available',required:true,detail:'Modo local: los comandos revisados se ejecutan en esta Mac. OCI requiere un runtime y una imagen configurados y no vuelve al modo local si falla.'});
 return{schemaVersion:1,channel:'local-pilot',platform:process.platform,architecture:process.arch,checks,productionReady:false,compatibilityCommand:'zhivex-code',releaseGates:['real-provider-coding','signed-notarized-bundle','trusted-updates','rollback-certification'],migration:'preflight-required'};
}
