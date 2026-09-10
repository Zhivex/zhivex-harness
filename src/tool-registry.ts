import type { ToolSet } from "@zhivex-ai/core";
import { HarnessConfigError } from "./errors.js";

/** Reserved regardless of which backend/skill subset is enabled. */
export const LOCAL_TOOL_NAMES = new Set([
  "list_files", "read_file", "read_files", "search_files", "search_many", "propose_edits", "apply_patch",
  "move_file", "quarantine_file", "restore_file", "run_check", "git_diff", "mutation_audit", "load_skill",
  "run_environment_command", "run_environment_batch", "run_environment_shell", "environment_status",
  "apply_reviewed_edits", "apply_reviewed_replacement", "read_task", "repair_plan", "inspect_environment_patch",
  "apply_environment_patch", "verify_and_apply_environment_patch", "verify_and_apply_reviewed_edits"
]);
export const assembleHarnessTools = (groups: readonly ToolSet[], external: ToolSet): ToolSet => {
  const tools: ToolSet = {};
  for (const group of groups) for (const [name, definition] of Object.entries(group)) {
    if (Object.hasOwn(tools, name)) throw new HarnessConfigError(`Duplicate local tool ${name}.`);
    tools[name] = { ...definition, metadata: { ...definition.metadata, source: "harness" } };
  }
  for (const [name, definition] of Object.entries(external)) {
    if (LOCAL_TOOL_NAMES.has(name) || name.startsWith("delegate_") || Object.hasOwn(tools, name)) {
      throw new HarnessConfigError(`MCP tool ${name} conflicts with a built-in workspace tool.`);
    }
    tools[name] = definition;
  }
  return tools;
};
