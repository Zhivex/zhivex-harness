import { createInterface } from "node:readline/promises";
import { addRegisteredProject, defaultRegistryPath, removeRegisteredProject } from "./project-registry.js";

export const PROJECT_HELP = `Usage: zhivex-code project <command>

Register a folder for the local browser. Run this inside the project folder.
The browser never asks for or opens a folder.

  project add [--tool-policy <path>]   Confirm this folder and add it to the local registry
  project remove                       Confirm this folder and remove it from the registry
  project --help                       Show this help

The registry is ${defaultRegistryPath()} and is readable only by your user.
Removing a project does not delete its files or its saved sessions.
A running zhivex-code web process detects the change without a restart.`;

async function confirmOnTerminal(folder: string, prompt: (text: string) => Promise<string>) {
  process.stdout.write(`Full path:\n${folder}\nType that path to confirm: `);
  const answer = (await prompt("")).trim();
  return answer === folder;
}

export async function runProjectCli(args: string[], options: {
  cwd?: string;
  prompt?: (text: string) => Promise<string>;
  file?: string;
} = {}) {
  const [command, ...rest] = args;
  if (command === undefined || command === "--help" || command === "help") {
    process.stdout.write(PROJECT_HELP + "\n");
    return;
  }
  if (command !== "add" && command !== "remove") throw new Error("PROJECT_USAGE_INVALID");
  let toolPolicy: string | undefined;
  for (let index = 0; index < rest.length; index++) {
    const name = rest[index];
    if (command === "add" && name === "--tool-policy" && rest[index + 1] && !rest[index + 1]!.startsWith("--")) {
      toolPolicy = rest[++index];
      continue;
    }
    throw new Error("PROJECT_USAGE_INVALID");
  }
  const prompt = options.prompt ?? (async () => {
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    try { return await rl.question(""); } finally { rl.close(); }
  });
  const file = options.file;
  const cwd = options.cwd ?? process.cwd();
  if (command === "add") {
    await addRegisteredProject(cwd, {
      ...(file ? { file } : {}),
      ...(toolPolicy ? { toolPolicy } : {}),
      confirm: folder => confirmOnTerminal(folder, prompt),
    });
    process.stdout.write("Project registered. A running local web process will show it.\n");
    return;
  }
  await removeRegisteredProject(cwd, {
    ...(file ? { file } : {}),
    confirm: folder => confirmOnTerminal(folder, prompt),
  });
  process.stdout.write("Project removed from the registry. Files on disk were kept.\n");
}
