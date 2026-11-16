import type { Readable } from "node:stream";
import { CliUsageError } from "./arguments.js";

export const MAX_STDIN_TASK_BYTES = 1024 * 1024;

/** Stdin is opt-in and is consumed before constructing a provider or opening state. */
export async function readStdinTask(input: Readable & { isTTY?: boolean } = process.stdin): Promise<string> {
  if (input.isTTY) throw new CliUsageError("Pipe a task into zhx run -, or use zhx run \"task\".");
  const chunks: Buffer[] = [];
  let bytes = 0;
  for await (const chunk of input) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    bytes += buffer.length;
    if (bytes > MAX_STDIN_TASK_BYTES) throw new CliUsageError("Stdin task exceeds 1 MiB. Send a smaller excerpt.");
    chunks.push(buffer);
  }
  let task: string;
  try { task = new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks)); }
  catch { throw new CliUsageError("Stdin task must be valid UTF-8 text."); }
  if (!task.trim()) throw new CliUsageError("Stdin task is empty. Pipe text into zhx run -.");
  return task;
}
