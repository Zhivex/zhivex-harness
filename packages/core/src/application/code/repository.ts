import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { realpath } from 'node:fs/promises';

const execute = promisify(execFile);

/** Validate without initializing a repository, checking out files, or inheriting Git overrides. */
export async function requireCodeRepository(workspace: string): Promise<void> {
  let output: string;
  try {
    const result = await execute('git', ['-C', workspace, '-c', 'core.hooksPath=/dev/null', '-c', 'core.fsmonitor=false', 'rev-parse', '--show-toplevel'], {
      env: {PATH: process.env.PATH, HOME: process.env.HOME, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null', GIT_TERMINAL_PROMPT: '0', GIT_OPTIONAL_LOCKS: '0'},
      timeout: 5000, maxBuffer: 65536,
    });
    output = result.stdout.replace(/\r?\n$/, '');
  } catch (error) {
    throw new Error((error as NodeJS.ErrnoException).code === 'ENOENT' ? 'CODE_GIT_UNAVAILABLE' : 'CODE_GIT_REQUIRED');
  }
  if (await realpath(output) !== workspace) throw new Error('CODE_GIT_ROOT_REQUIRED');
}
