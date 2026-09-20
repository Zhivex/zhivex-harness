import { rm, mkdir, copyFile } from "node:fs/promises";
import path from "node:path";
const root=path.resolve(import.meta.dir,"..");
const outdir=path.join(root,"build");await rm(outdir,{recursive:true,force:true});await mkdir(outdir);
const metadata=await Bun.file(path.join(root,"../package.json")).json();
const versionPlugin:Bun.BunPlugin={name:"embedded-runtime-version",setup(builder){builder.onLoad({filter:/[\\/]src[\\/]sqlite-database\.ts$/},async args=>({contents:(await Bun.file(args.path).text()).replace("createRequire(import.meta.url)","createRequire(process.execPath)"),loader:"ts"}));builder.onLoad({filter:/[\\/]src[\\/]version\.ts$/},()=>({contents:`export const HARNESS_VERSION=${JSON.stringify(metadata.version)}; export const NODE_ENGINE_RANGE=${JSON.stringify(metadata.engines.node)}; export const BUN_ENGINE_RANGE=${JSON.stringify(metadata.engines.bun)};`,loader:"ts"}));}};
for(const name of ["main","preload","runtime"]){
 const result=await Bun.build({entrypoints:[path.join(root,`src/${name}.ts`)],outdir,target:"node",format:"cjs",naming:`${name}.cjs`,external:["electron"],plugins:[versionPlugin],define:{"process.env.NODE_ENV":JSON.stringify("production")}});
 if(!result.success)throw new AggregateError(result.logs,`Build ${name} failed`);
}
const renderer=await Bun.build({entrypoints:[path.join(root,"src/renderer.tsx")],outdir,target:"browser",format:"esm",define:{"process.env.NODE_ENV":JSON.stringify("production")},minify:true});
if(!renderer.success)throw new AggregateError(renderer.logs,"Renderer build failed");
await copyFile(path.join(root,"src/index.html"),path.join(outdir,"index.html"));
console.log("Desktop bundles built with Bun.");
