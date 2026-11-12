import { mkdir, writeFile, chmod } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

if (process.platform !== 'darwin') throw new Error('This launcher targets macOS.');
const root=fileURLToPath(new URL('../',import.meta.url));
const application=path.resolve(root,'../../release-artifacts/Zhivex Assistant.app');
const node=execFileSync('/usr/bin/which',['node'],{encoding:'utf8'}).trim();
const quote=(value:string)=>"'"+value.replaceAll("'","'\\''")+"'";
await mkdir(path.join(application,'Contents/MacOS'),{recursive:true});
await writeFile(path.join(application,'Contents/Info.plist'),`<?xml version="1.0" encoding="UTF-8"?><!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd"><plist version="1.0"><dict><key>CFBundleExecutable</key><string>assistant</string><key>CFBundleIdentifier</key><string>ai.zhivex.assistant.local</string><key>CFBundleName</key><string>Zhivex Assistant</string><key>CFBundlePackageType</key><string>APPL</string><key>LSUIElement</key><true/></dict></plist>`);
const executable=path.join(application,'Contents/MacOS/assistant');
await writeFile(executable,`#!/bin/sh\n(\ntrap '' HUP\n${quote(node)} ${quote(path.join(root,'dist/cli.js'))} --setup --open >/dev/null 2>&1\nresult=$?\nif [ "$result" -ne 0 ]; then\n /usr/bin/osascript -e 'display alert "No se pudo abrir Zhivex Assistant" message "Comprobá que el proyecto y Node sigan instalados. Si Assistant ya está abierto, volvé a su ventana."'\nfi\nexit "$result"\n) &\nexit 0\n`);
await chmod(executable,0o755);
console.log(application);
