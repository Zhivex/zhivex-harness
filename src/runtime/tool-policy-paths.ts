import { z } from 'zod';
import { applyEditProposalInputSchema, editProposalInputSchema, moveFileInputSchema, quarantineFileInputSchema, workspaceFilePathSchema } from '../workspace/edit-contracts.js';
import { replacementEditSchema } from '../workspace/replacement-edits.js';
import type { HarnessToolPolicy } from './tool-policy.js';

// Versioned together with the schema-bound projections below. Directory searches,
// shell commands and opaque restore IDs do not enumerate exact touched files.
export const BUILTIN_TOOL_POLICY_PATHS_VERSION = 'builtin-exact-files-v1';
const one = z.object({ path: workspaceFilePathSchema });
const many = z.object({ files: z.array(one).min(1).max(100) });
const resolvers: Record<string, (input: unknown) => readonly string[]> = {
  read_file: input => [one.parse(input).path],
  read_files: input => many.parse(input).files.map(file => file.path),
  propose_edits: input => editProposalInputSchema.parse(input).changes.map(change => change.path),
  apply_reviewed_edits: input => editProposalInputSchema.parse(input).changes.map(change => change.path),
  apply_patch: input => applyEditProposalInputSchema.parse(input).changes.map(change => change.path),
  apply_reviewed_replacement: input => [replacementEditSchema.parse(input).path],
  move_file: input => { const parsed = moveFileInputSchema.parse(input); return [parsed.source, parsed.destination]; },
  quarantine_file: input => [quarantineFileInputSchema.parse(input).path]
};

export const validateBuiltinToolPolicy = (policy: HarnessToolPolicy, tools: readonly string[]) => {
  for (const rule of policy.rules) for (const name of rule.tools) {
    if (!tools.includes(name)) throw new Error(`Tool policy references unavailable tool ${name}.`);
    if (rule.paths && !Object.hasOwn(resolvers, name)) throw new Error(`Tool policy cannot safely resolve paths for ${name}.`);
  }
};

/** Only invoked for tools with a path-scoped rule; irrelevant inputs stay opaque. */
export const builtinToolPolicyPathResolver = (policy: HarnessToolPolicy) => {
  const scoped = new Set(policy.rules.filter(rule => rule.paths).flatMap(rule => rule.tools));
  return (name: string, input: unknown): readonly string[] => {
    if (!scoped.has(name)) return [];
    if (!Object.hasOwn(resolvers, name)) throw new Error(`Tool policy cannot safely resolve paths for ${name}.`);
    return resolvers[name]!(input);
  };
};
