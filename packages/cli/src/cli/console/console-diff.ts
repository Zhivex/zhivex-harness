import type { Workspace } from '@zhivex-ai/harness/engine';
import { formatConsoleDiff } from './console-context.js';
import { sanitizeTerminalText } from '../terminal/terminal-ui.js';

export async function consoleWorkspaceDiff(workspace: Workspace, color = false): Promise<string> {
  const result = await workspace.gitDiff();
  const commands = [result.status, result.diff, result.staged];
  const failed = commands.filter(command => command.exitCode !== 0 || command.timedOut);
  if (failed.length) return 'Git review unavailable; absence of changes is not established.\n' +
    failed.map(command => sanitizeTerminalText(command.stderr.trim() || `Git command failed (exit ${command.exitCode}, timeout ${command.timedOut}).`)).join('\n') +
    '\nUse /activity for observed mutations; initialize Git or inspect files manually.\n';
  return formatConsoleDiff(commands.map(command => command.stdout).join(''), color) || 'No Git-visible workspace changes.\n';
}
