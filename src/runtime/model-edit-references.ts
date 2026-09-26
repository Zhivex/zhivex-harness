import { toToolSet, type JsonValue, type LanguageModelMiddleware, type ModelMessage, type ToolCall, type ToolExecutionResult, type ToolSet } from "@zhivex-ai/core";
import { z } from "zod";
import path from "node:path";
import { fileDigestSchema, workspaceFilePathSchema, MAX_EDIT_CHANGES, MAX_EDIT_FILE_BYTES } from "../workspace/edit-contracts.js";
import { replacementEditSchema } from "../workspace/replacement-edits.js";

const imports = new Set(["apply_environment_patch", "verify_and_apply_environment_patch"]);
const edits = new Set(["apply_reviewed_edits", "verify_and_apply_reviewed_edits"]);
const replacement = "apply_reviewed_replacement";
const object = (value: unknown): Record<string, JsonValue> | undefined =>
  value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, JsonValue> : undefined;
const readPaths = (call: ToolCall): Set<string> => {
  const input = object(call.input);
  const requests = call.name === "read_file" ? [input] : call.name === "read_files" && Array.isArray(input?.files) ? input.files : [];
  const paths = new Set<string>();
  for (const request of requests) {
    const value = object(request)?.path;
    if (typeof value !== "string") continue;
    // Reads accept ./ prefixes and redundant separators, while edits require
    // normalized paths. Resolve aliases lexically, without looking at disk.
    const normalized = path.normalize(value).split(path.sep).join("/");
    if (workspaceFilePathSchema.safeParse(normalized).success) paths.add(normalized);
  }
  return paths;
};
const readRecovery = (call: ToolCall, result: ToolExecutionResult, batchAvailable: boolean): string | undefined => {
  if (result.error?.code === "TOOL_INPUT_VALIDATION_ERROR") {
    if (call.name === "read_file") return 'read_file reads ONE file: {"path":"relative/file","startLine":1,"endLine":120}. The required path must be a string; files is not a read_file argument.' + (batchAvailable ? ' For multiple slices use read_files with {"files":[{"path":"relative/file","startLine":1,"endLine":120}]}; files must be an array, not a JSON-encoded string.' : ' Submit one file per read_file call.');
    return 'read_files requires {"files":[{"path":"relative/file","startLine":1,"endLine":120}]}. Supply an actual array of objects, not a JSON-encoded string. Every item needs a string path.';
  }
  if (result.error?.message.startsWith("Invalid line range for ")) return "startLine and endLine are absolute, inclusive line numbers, not a line count. endLine must be at least startLine; omit endLine to use the default bounded slice. Correct the range before retrying.";
};
const referenceRecovery = (call: ToolCall, result: ToolExecutionResult): string | undefined => {
  if (result.error?.code !== "TOOL_INPUT_VALIDATION_ERROR") return;
  const args = object(call.input);
  if (!args) return;
  const issues = result.error.issues ?? [];
  if (imports.has(call.name) && !("patchId" in args) && issues.some(issue => issue.path[0] === "patchId")) {
    return "No successful patch inspection is available in this request. Call inspect_environment_patch, wait for its successful result, then retry this import in a later turn. Omit patchId; the runtime binds the inspected snapshot before requesting approval. Do not invent a hash.";
  }
  const missingDigest = call.name === replacement
    ? !("expectedDigest" in args) && issues.some(issue => issue.path[0] === "expectedDigest")
    : edits.has(call.name) && issues.some(issue => {
      const [field, index, digest] = issue.path;
      const item = field === "changes" && typeof index === "number" && Array.isArray(args.changes) ? object(args.changes[index]) : undefined;
      return digest === "expectedDigest" && item && !("expectedDigest" in item);
    });
  if (missingDigest) return "No successful read is available for an existing edit target in this request. Call read_file or read_files for every existing target, wait for successful results, then retry the edit in a later turn. Omit expectedDigest; the runtime binds those reads before requesting approval. Do not invent a hash or mark an existing file as create=true.";
};
const change = z.strictObject({ path: workspaceFilePathSchema,
  content: z.string().max(MAX_EDIT_FILE_BYTES), create: z.boolean().optional().describe("Set true only to create a new file; existing files must have been read first.") });

/** Provider-only view. Durable calls, approval digests and execution schemas remain explicit.
 * References come from successful reads visible in this request, never from a fresh
 * filesystem lookup after approval. Missing/compacted evidence fails schema validation.
 */
export const createModelEditReferences = (registered: ToolSet): LanguageModelMiddleware => {
  const prepare = (input: { messages: ModelMessage[]; tools?: ToolSet }) => {
    const active = new Set<string>();
    const activeReads = new Set<string>();
    const tools = toToolSet(input.tools) ?? {};
    const visible = { ...tools };
    for (const [name, definition] of Object.entries(toToolSet(registered) ?? {})) {
      const selected = tools[name];
      if (!selected || !("schema" in selected) || !("schema" in definition) || selected.schema !== definition.schema) continue;
      if (name === "read_file" || name === "read_files") activeReads.add(name);
      const schema = definition.schema;
      if (!(schema instanceof z.ZodObject)) continue;
      let publicSchema: z.ZodType | undefined;
      if (imports.has(name)) publicSchema = schema.omit({ patchId: true });
      if (edits.has(name)) publicSchema = schema.extend({ changes: z.array(change).min(1).max(MAX_EDIT_CHANGES) });
      if (name === replacement) publicSchema = replacementEditSchema.omit({ expectedDigest: true });
      if (!publicSchema) continue;
      active.add(name);
      visible[name] = { ...tools[name]!, schema: publicSchema,
        description: imports.has(name)
          ? "Request approval to import the last successfully inspected OCI patch. Call inspect_environment_patch first in a preceding turn. The runtime binds the exact inspected snapshot; changes after inspection or approval are rejected. " + (name.startsWith("verify_") ? "Run the exact allowlisted command and args before importing; verification must succeed without changing the patch." : "")
          : "Request approval for these exact edits. Read every existing target first with read_file or read_files in a preceding turn. The runtime binds the digest from that read and rejects stale files. " + (name === replacement ? "Replace exactly one literal oldText with newText; include enough context to make oldText unique." : "Supply full content per file; set create=true only for a new file. ") + (name.startsWith("verify_") ? "Run the exact command and args and import only after successful verification." : "") };
    }
    const digests = new Map<string, string>();
    let patchId: string | undefined;
    const calls = new Map<string, { call: ToolCall; paths: Set<string> }>();
    const recovery = new Map<ToolExecutionResult, string>();
    const seenCalls = new Set<string>();
    const latestReads = new Map<string, string>();
    let latestInspection: string | undefined;
    for (const message of input.messages) for (const part of message.parts) {
      if (message.role === "assistant" && part.type === "tool-call") {
        const call = part.toolCall;
        const paths = readPaths(call);
        // A failed or unfinished refresh must not fall back to older evidence.
        for (const target of paths) {
          digests.delete(target);
          latestReads.set(target, call.id);
        }
        if (call.name === "inspect_environment_patch") {
          patchId = undefined;
          latestInspection = call.id;
        }
        if (seenCalls.has(call.id)) calls.delete(call.id);
        else {
          seenCalls.add(call.id);
          calls.set(call.id, { call, paths });
        }
      }
      if (message.role !== "tool" || part.type !== "tool-result") continue;
      const result = part.toolResult;
      const call = calls.get(result.toolCallId);
      if (!call || call.call.name !== result.toolName) continue;
      calls.delete(result.toolCallId);
      if (result.isError) {
        const guidance = activeReads.has(result.toolName) ? readRecovery(call.call, result, activeReads.has("read_files"))
          : active.has(result.toolName) ? referenceRecovery(call.call, result) : undefined;
        if (guidance) recovery.set(result, guidance);
        continue;
      }
      const output = object(result.output);
      if (!output) continue;
      if (result.toolName === "inspect_environment_patch" && latestInspection === result.toolCallId && output.kind === "environment-patch" && typeof output.patchId === "string" && fileDigestSchema.safeParse(output.patchId).success) patchId = output.patchId;
      const files = result.toolName === "read_file" ? [output] : result.toolName === "read_files" && Array.isArray(output.files) ? output.files : [];
      for (const value of files) {
        const file = object(value);
        if (file && typeof file.path === "string" && typeof file.digest === "string" && call.paths.has(file.path) && latestReads.get(file.path) === result.toolCallId &&
          workspaceFilePathSchema.safeParse(file.path).success && fileDigestSchema.safeParse(file.digest).success) digests.set(file.path, file.digest);
      }
    }
    // Provider-facing guidance only; durable error receipts and approved calls
    // remain unchanged, and no reference is synthesized from an error.
    if (recovery.size) input.messages = input.messages.map(message => ({ ...message, parts: message.parts.map(part => {
      const guidance = part.type === "tool-result" ? recovery.get(part.toolResult) : undefined;
      return part.type === "tool-result" && guidance && part.toolResult.error
        ? { ...part, toolResult: { ...part.toolResult, error: { ...part.toolResult.error, message: `${part.toolResult.error.message} ${guidance}` } } }
        : part;
    }) }));
    const bindChange = (value: JsonValue): JsonValue => {
      const item = object(value);
      if (!item || "expectedDigest" in item) return value;
      // Invalid flags remain invalid instead of silently becoming an overwrite.
      if (item.create !== undefined && typeof item.create !== "boolean") return value;
      const { create, ...rest } = item;
      const digest = create === true ? null : (typeof item.path === "string" ? digests.get(item.path) : undefined);
      return { ...rest, ...(digest !== undefined ? { expectedDigest: digest } : {}) };
    };
    const bind = (call: ToolCall): ToolCall => {
      const args = object(call.input);
      if (!active.has(call.name) || !args) return call;
      if (imports.has(call.name)) return { ...call, input: { ...args, ...(!("patchId" in args) && patchId ? { patchId } : {}) } };
      if (call.name === replacement) return { ...call, input: bindChange(args) };
      return { ...call, input: { ...args, ...(Array.isArray(args.changes) ? { changes: args.changes.map(bindChange) } : {}) } };
    };
    input.tools = visible;
    return bind;
  };
  return {
    name: "harness-model-edit-references-v1",
    async wrapStream(context, next) {
      const bind = prepare(context.input);
      const stream = await next();
      return (async function* () { for await (const event of stream) yield event.type === "tool-call" ? { ...event, toolCall: bind(event.toolCall) } : event; })();
    },
    async wrapGenerate(context, next) {
      const bind = prepare(context.input);
      const result = await next();
      const message = (value: ModelMessage): ModelMessage => ({ ...value, parts: value.parts.map(part => part.type === "tool-call" ? { ...part, toolCall: bind(part.toolCall) } : part) });
      return { ...result, ...(result.message ? { message: message(result.message) } : {}), ...(result.messages ? { messages: result.messages.map(message) } : {}) };
    }
  };
};
