import type { ToolSet } from '@zhivex-ai/core';
import type { HarnessConfig } from './config.js';
import { resolvePackageCheckCommand } from '../execution/package-manager.js';
import { createHarnessToolPolicy, type HarnessToolPolicy } from './tool-policy.js';
import { compileTaskAcceptanceContract } from './task-acceptance.js';
import { lstat, realpath } from 'node:fs/promises';
import path from 'node:path';
import { isHardIgnored } from '../workspace/path-policy.js';
import { readRegularFileNoFollow } from '../workspace/file-security.js';

/** Admission-time inspection only; execution must still revalidate changing files. */
export async function validateTaskAcceptanceWorkspace(input: unknown, host: {
  config: HarnessConfig; tools: ToolSet; policy?: HarnessToolPolicy;
}) {
  const compiled = compileTaskAcceptanceContract(input);
  const root = await realpath(host.config.workspace);
  for (const filename of compiled.contract.allowedWritePaths) {
    if (isHardIgnored(filename)) throw new Error('TASK_ACCEPTANCE_PATH_DENIED: write path is protected by workspace policy.');
    const segments = filename.split('/');
    let current = root;
    for (let index=0; index<segments.length; index++) {
      current = path.join(current, segments[index]!);
      try {
        const entry = await lstat(current);
        const leaf = index === segments.length-1;
        if (entry.isSymbolicLink() || (leaf ? !entry.isFile() || entry.nlink !== 1 : !entry.isDirectory())) {
          throw new Error('TASK_ACCEPTANCE_PATH_DENIED: write paths require regular files and real directory ancestors.');
        }
      } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') break; throw error; }
    }
  }
  let packageManifest: { packageManager?: unknown; scripts?: unknown } | undefined;
  if (compiled.contract.requiredChecks.some(check => check.kind === 'package-script')) {
    try {
      const file = await readRegularFileNoFollow(path.join(root,'package.json'), { label:'Task acceptance package manifest', maxBytes:256*1024, requireSingleLink:true });
      const parsed: unknown = JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(file.contents));
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('Manifest must be an object.');
      packageManifest = parsed;
    } catch { throw new Error('TASK_ACCEPTANCE_MANIFEST_INVALID: package.json must be a bounded regular JSON object without links.'); }
  }
  return validateTaskAcceptanceContract(compiled.contract,{...host,...(packageManifest ? {packageManifest} : {})});
}

/** Read-only host preflight. Manifest must come from the host's bounded safe reader. */
export async function validateTaskAcceptanceContract(input: unknown, host: {
  config: HarnessConfig; tools: ToolSet; packageManifest?: { packageManager?: unknown; scripts?: unknown }; policy?: HarnessToolPolicy;
}) {
  const compiled = compileTaskAcceptanceContract(input);
  const policy = host.policy ? createHarnessToolPolicy(host.policy) : undefined;
  for (const check of compiled.contract.requiredChecks) {
    const fail = (reason: string): never => { throw new Error(`TASK_ACCEPTANCE_UNEXECUTABLE: check ${check.id}: ${reason}`); };
    if (check.execution.backend !== host.config.execution.backend) fail('execution backend does not match the selected host.');
    const toolName = check.kind === 'package-script' ? 'run_check' : 'run_environment_command';
    const tool = host.tools[toolName];
    if (!tool || !('execute' in tool)) fail(`required tool ${toolName} is unavailable.`);
    if (policy?.evaluate({ toolName, requiresApproval: true }).decision === 'deny') fail('host tool policy denies the required check.');
    if (host.config.execution.backend === 'oci' && !host.config.execution.allowedCommands.includes(check.command)) fail('command is not in the OCI allowlist.');
    if (check.kind === 'package-script') {
      if (!host.packageManifest) fail('a safely read package manifest is required.');
      let resolved;
      try { resolved = await resolvePackageCheckCommand(host.config.workspace, host.packageManifest!, check.script, check.expectedScript, host.config.allowedChecks); }
      catch (error) { fail(error instanceof Error ? error.message : 'package check could not be resolved.'); }
      if (JSON.stringify(resolved!.command) !== JSON.stringify([check.command,...check.args])) fail('command/arguments differ from the host-resolved package check.');
    }
  }
  return compiled;
}
