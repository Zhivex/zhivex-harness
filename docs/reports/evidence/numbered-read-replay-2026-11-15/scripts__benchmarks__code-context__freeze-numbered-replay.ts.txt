import assert from 'node:assert/strict';
import {mkdir,readFile,writeFile,copyFile,symlink} from 'node:fs/promises';
import path from 'node:path';
import {createHash} from 'node:crypto';
const old=path.resolve(process.argv[2]!),directory=path.resolve(process.argv[3]!);
const hash=(b:string|Buffer)=>createHash('sha256').update(b).digest('hex');
const previous=JSON.parse(await readFile(path.join(old,'manifest.json'),'utf8'));
const baseline=await readFile(path.join(old,'after.mjs'));
assert.equal(hash(baseline),previous.bundles.after,'Baseline must match previous frozen optimized runtime');
await mkdir(directory);
await copyFile(path.join(old,'after.mjs'),path.join(directory,'before.mjs'));
const build=await Bun.build({entrypoints:['packages/core/src/runtime/harness.ts'],outdir:directory,naming:'after.mjs',target:'bun',packages:'external'});
assert(build.success,build.logs.map(String).join('\n'));
await symlink(path.resolve('node_modules'),path.join(directory,'node_modules'),'dir');
const modules=['packages/core/src/context/request-projection.ts','packages/core/src/context/working-read-replay.ts','packages/core/src/context/read-attempts.ts','packages/core/src/context/numbered-read-lines.ts','packages/core/src/context/lossless-lines.ts','packages/core/src/runtime/harness.ts'];
const manifest={method:'Before is the immutable optimized runtime from the previous non-repetitive-code campaign. After adds exact sequential line-prefix encoding to restored reads; replay, diagnostics, and security are otherwise unchanged. Common benchmark instrumentation is used in both arms.',previous,
 bundles:{before:hash(baseline),after:hash(await readFile(path.join(directory,'after.mjs')))},modules:Object.fromEntries(await Promise.all(modules.map(async p=>[p,hash(await readFile(p))])))};
await writeFile(path.join(directory,'manifest.json'),JSON.stringify(manifest,null,2)+'\n');console.log(JSON.stringify(manifest));
