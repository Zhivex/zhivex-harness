import {spawn} from "node:child_process";
import {mkdtemp,readFile} from "node:fs/promises";
import path from "node:path";
const root=path.resolve(import.meta.dir,"..");
const packaged=process.argv.includes("--packaged");
const credentials=process.argv.includes("--credentials");
const build=packaged?path.join(root,"out/Zhivex Harness-darwin-arm64/Zhivex Harness.app/Contents/Resources/app.asar/build"):path.join(root,"build");
const report=await mkdtemp("/tmp/har-layout-");
const child=spawn(path.join(root,"node_modules/electron/dist/Electron.app/Contents/MacOS/Electron"),[path.join(import.meta.dir,credentials?"credential-ui-runner.cjs":"layout-runner.cjs"),build,report],{cwd:root,env:{PATH:process.env.PATH,HOME:report},stdio:["ignore","ignore","pipe"]});
let diagnostic="";child.stderr.on("data",value=>{diagnostic=(diagnostic+value).slice(-16384);});
const timer=setTimeout(()=>child.kill("SIGKILL"),30000);
try{const code=await new Promise<number|null>((resolve,reject)=>{child.once("exit",resolve);child.once("error",reject);});if(code!==0)throw new Error(`LAYOUT_FAILED: ${report}\n${diagnostic}`);console.log(JSON.stringify({packagedRenderer:packaged,report,checks:JSON.parse(await readFile(path.join(report,"report.json"),"utf8"))}));}finally{clearTimeout(timer);if(child.exitCode===null&&child.signalCode===null)child.kill("SIGKILL");}
