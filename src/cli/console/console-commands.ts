/** Presentation shared by the direct console and the local-service client. */
export const CONSOLE_COMMAND_CATALOG = [
  ["/menu", "Open navigation menu", true],
  ["/help", "Show commands; /help all shows everything", true],
  ["/connection", "Inspect credentials and optionally test selected model access", false],
  ["/credentials", "Manage provider keys in the system keychain or this session", false],
  ["/provider", "Select a provider", false],
  ["/model", "Select a model", false],
  ["/route", "Configure specialist model routes", false],
  ["/status", "Inspect the current session and run", true],
  ["/diff", "Review workspace changes", false],
  ["/review", "Review a task", false],
  ["/resume", "Reopen a conversation by session ID", true],
  ["/pending", "Inspect pending approvals", true],
  ["/approve", "Approve the pending actions", true],
  ["/deny", "Deny the pending actions", true],
  ["/approvals", "Change approval mode for this CLI session", false],
  ["/continue", "Continue an interrupted task with retained results in a new run", false],
  ["/compact", "Compact conversation context", false],
  ["/compaction", "Choose a compaction model or inspect recommendations", false],
  ["/new", "Start a new conversation", true],
  ["/rename", "Rename the current conversation", true],
  ["/clear", "Clear conversation context", false],
  ["/exit", "Exit the console", true],
  ["/paste", "Compose a literal multiline draft", true],
  ["/verbose", "Toggle full or compact activity details", false],
  ["/context", "Inspect project rules and selected context", false],
  ["/attach", "Attach a workspace file to the next request", false],
  ["/attachments", "List selected attachments", false],
  ["/detach", "Remove selected attachments", false],
  ["/sessions", "Find saved conversations", true],
  ["/limits", "Inspect or change the step limit for next turns", false],
  ["/usage", "Inspect transport usage", false],
  ["/cancel", "Cancel the active run", true],
] as const;

export type ConsoleMode = "direct" | "service";
export const consoleCommands = (mode: ConsoleMode = "direct") =>
  CONSOLE_COMMAND_CATALOG.filter(([name, , service]) => mode === "service" ? service : name !== "/cancel");

const everyday = new Set(["/menu", "/help", "/model", "/new", "/sessions", "/attach", "/diff", "/exit"]);
const approvals = new Set(["/approvals", "/pending", "/approve", "/deny"]);

export const searchConsoleCommands = (query: string, mode: ConsoleMode = "direct") => {
  const search = query.replace(/^\//, "").toLowerCase();
  return consoleCommands(mode).filter(([name, description]) =>
    search ? name.slice(1).startsWith(search) || description.toLowerCase().includes(search) : everyday.has(name))
    .sort(([a], [b]) => Number(b.slice(1).startsWith(search)) - Number(a.slice(1).startsWith(search)));
};

const argumentsFor: Readonly<Record<string, string>> = {
  "/limits": "[positive integer]",
  "/compaction": "[provider:model|off|recommend]",
  "/approvals": "[ask|auto|restricted]",
  "/provider": "[id]", "/model": "[id]", "/route": "[role=provider[:model] | clear [role]]",
  "/review": "<task>", "/resume": "[last|sessionId]", "/new": "[title]",
  "/rename": "<title>", "/attach": "<path>", "/detach": "[path]", "/sessions": "[search]",
};

export const formatConsoleHelp = (mode: ConsoleMode = "direct", all = false) => {
  const commands = consoleCommands(mode);
  const format = (names: Set<string>) => commands.filter(([name]) => names.has(name)).map(([name, description]) => {
    const args = mode === "service" && name === "/new" ? "" :
      mode === "service" && name === "/resume" ? "[sessionId]" : name === "/help" ? "[all]" : argumentsFor[name] ?? "";
    return `${`${name} ${args}`.trim().padEnd(28)} ${description}`;
  }).join("\n");
  return "Everyday commands:\n" + format(everyday) +
    "\n\nPending approvals (review the actions before deciding):\n" + format(approvals) +
    (all ? "\n\nAdvanced commands:\n" + format(new Set(commands.map(([name]) => name).filter(name => !everyday.has(name) && !approvals.has(name)))) : "\n\nUse /help all for advanced commands, or type / followed by a search term.") +
    "\nUp/Down selects, Tab inserts, Enter submits. Ctrl+R searches prompt history.\n" +
    "? shows shortcuts; Alt+Enter inserts a newline. Bracketed paste stays literal.\n" +
    "Ctrl+C discards input or stops the active operation.\n" +
    (mode === "service" ? "Provider, model and tool policy are managed by the service host.\n" : "");
};
