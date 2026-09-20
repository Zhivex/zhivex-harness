import {mkdir} from "node:fs/promises";
import path from "node:path";
// Run after the desktop bundle build, which recreates build/.
if(process.platform!=="darwin")throw new Error("CREDENTIAL_PLATFORM_UNSUPPORTED");
const root=path.resolve(import.meta.dir,"..");
await mkdir(path.join(root,"build"),{recursive:true});
const command=Bun.spawn(["/usr/bin/swiftc","-O","-module-cache-path",path.join(root,"node_modules/.cache/swift"),path.join(root,"native/CredentialStore.swift"),"-o",path.join(root,"build/credential-store"),"-framework","Security","-framework","AppKit"],{stdout:"inherit",stderr:"inherit"});
if(await command.exited!==0)throw new Error("CREDENTIAL_HELPER_BUILD_FAILED");
console.log("Native macOS credential helper built.");
