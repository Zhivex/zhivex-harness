#!/usr/bin/env node
/** Compatibility executable: all normal commands use the canonical zhx terminal. */
import {runCli} from '@zhivex-ai/harness/cli';
import {realpathSync} from 'node:fs';
import {fileURLToPath} from 'node:url';
export * from '@zhivex-ai/harness/cli';
try {if (process.argv[1] && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url))) void runCli();} catch {}
