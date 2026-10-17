const READ_ONLY = /^(read|list|search|grep|glob|find)_/;

/** File and search tools that do not change the workspace. */
export function isReadOnlyTool(name: string): boolean {
  return READ_ONLY.test(name) || ["read_file", "list_dir", "grep", "glob"].includes(name);
}

export type ToolRow = { name: string; status: string; exitCode?: number; timedOut?: boolean };

export type ToolGroup =
  | { kind: "explore"; count: number; tools: ToolRow[] }
  | { kind: "tool"; tool: ToolRow };

/** Fold a consecutive run of read-only calls into one "Explored N files" group. */
export function groupToolRows(tools: readonly ToolRow[]): ToolGroup[] {
  const groups: ToolGroup[] = [];
  for (const tool of tools) {
    const last = groups.at(-1);
    if (isReadOnlyTool(tool.name) && last?.kind === "explore") {
      last.tools.push(tool);
      last.count += 1;
    } else if (isReadOnlyTool(tool.name)) {
      groups.push({ kind: "explore", count: 1, tools: [tool] });
    } else {
      groups.push({ kind: "tool", tool });
    }
  }
  return groups;
}
