import {cp,mkdir,mkdtemp,readFile,writeFile,symlink,rm,stat} from "node:fs/promises";
import {createHash} from "node:crypto";
import {execFileSync} from "node:child_process";
import path from "node:path";
import {createRequire} from "node:module";
const root=path.resolve(import.meta.dir,"..");const require=createRequire(path.join(root,"package.json"));const {extractFile}=require("@electron/asar") as {extractFile(file:string,name:string):Buffer};
const meta=await Bun.file(path.join(root,"package.json")).json();const app=path.join(root,"out/Zhivex Harness-darwin-arm64/Zhivex Harness.app");
const command=(binary:string,args:string[])=>execFileSync(binary,args,{encoding:"utf8",stdio:["ignore","pipe","pipe"]}).trim();
const plist=JSON.parse(command("/usr/bin/plutil",["-convert","json","-o","-",path.join(app,"Contents/Info.plist")]));
if(plist.ZhivexDesktopVersion!==meta.version||plist.CFBundleShortVersionString!==meta.version.split(/[+-]/)[0]||plist.CFBundleVersion!==meta.version.split(/[+-]/)[0]||plist.CFBundleIdentifier!=="ai.zhivex.harness")throw new Error("INSTALLER_BUNDLE_METADATA_MISMATCH");
const runtime=JSON.parse(extractFile(path.join(app,"Contents/Resources/app.asar"),"build/runtime-metadata.json").toString());
if(runtime.desktopVersion!==meta.version||runtime.electronVersion!==meta.devDependencies.electron)throw new Error("INSTALLER_RUNTIME_METADATA_MISMATCH");
const helper=path.join(app,"Contents/Resources/credential-store"),updateHelper=path.join(app,"Contents/Resources/update-worker-lock");for(const file of [helper,updateHelper,path.join(app,"Contents/MacOS/Zhivex Harness")])if(command("/usr/bin/lipo",["-archs",file])!=="arm64")throw new Error("INSTALLER_ARCH_MISMATCH");
const helperBuild=command("/usr/bin/xcrun",["vtool","-show-build",helper]);const minimum=helperBuild.match(/\bminos\s+([\d.]+)/)?.[1];if(minimum!==plist.LSMinimumSystemVersion)throw new Error("INSTALLER_MINIMUM_OS_MISMATCH");
if(command("/usr/bin/xcrun",["vtool","-show-build",updateHelper]).match(/\bminos\s+([\d.]+)/)?.[1]!==minimum)throw new Error("INSTALLER_UPDATE_HELPER_MINIMUM_OS_MISMATCH");
const output=path.join(root,"out/installer");await mkdir(output,{recursive:true});const stage=await mkdtemp("/tmp/har-installer-stage-");
const name=`Zhivex-Harness-${meta.version}-darwin-arm64-unsigned.dmg`;const image=path.join(output,name);const revision=command("git",["-C",root,"rev-parse","HEAD"]);const dirty=Boolean(command("git",["-C",root,"status","--porcelain"]));
const notes=`# Zhivex Harness ${meta.version}\n\nLocal unsigned candidate. Developer ID signing and notarization are deferred; not published.\n\n- Desktop ${meta.version}; Harness ${runtime.harnessVersion}; Electron ${runtime.electronVersion}.\n- Apple Silicon arm64; minimum compilation target macOS ${minimum}.\n- Governed conversations, reviewed Git delivery and macOS Keychain credentials.\n- Source reference: ${revision}; working tree modified: ${dirty}. This reference alone does not identify all candidate source bytes.\n- Node runtime is bundled. Git/gh and OCI engines remain external.\n- Preserve application state and repositories when uninstalling. See INSTALLATION.md.\n`;
try{
 await cp(app,path.join(stage,"Zhivex Harness.app"),{recursive:true,verbatimSymlinks:true,preserveTimestamps:true});await symlink("/Applications",path.join(stage,"Applications"));await cp(path.join(root,"INSTALLATION.md"),path.join(stage,"INSTALLATION.md"));await writeFile(path.join(stage,"RELEASE_NOTES.md"),notes);
 command("/usr/bin/hdiutil",["create","-volname","Zhivex Harness","-srcfolder",stage,"-format","UDZO","-fs","HFS+","-ov","-o",image]);command("/usr/bin/hdiutil",["verify",image]);
 const digest=async(file:string)=>({sha256:createHash("sha256").update(await readFile(file)).digest("hex"),bytes:(await stat(file)).size});
 const manifest={schemaVersion:1,desktopVersion:meta.version,harnessVersion:runtime.harnessVersion,electronVersion:runtime.electronVersion,platform:"darwin",architecture:"arm64",minimumCompilationTarget:minimum,developerIdSigned:false,notarized:false,published:false,source:{revision,workingTreeModified:dirty},artifact:{file:name,...await digest(image)},contents:{asar:await digest(path.join(app,"Contents/Resources/app.asar")),credentialHelper:await digest(helper),updateWorkerHelper:await digest(updateHelper)},builtOnMacOS:command("/usr/bin/sw_vers",["-productVersion"])};
 await writeFile(path.join(output,"release-manifest.json"),JSON.stringify(manifest,null,2)+"\n");await writeFile(path.join(output,"RELEASE_NOTES.md"),notes);await cp(path.join(root,"INSTALLATION.md"),path.join(output,"INSTALLATION.md"));console.log(JSON.stringify({directory:output,manifest}));
}finally{await rm(stage,{recursive:true,force:true});}
