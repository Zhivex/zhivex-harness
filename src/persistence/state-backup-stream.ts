import { readRegularFileChunksNoFollow } from "../workspace/file-security.js";

// Versioned transport; the logical bundle and its canonical checksum stay v1.
const MAGIC = "ZHIVEX-STATE-SEGMENTS-1\n";
const STRING_CHARS = 8192;
const MAX_FRAME_BYTES = 64 * 1024;

/** Canonical JSON without allocating a serialized copy of the entire bundle. */
export function* canonicalChunks(value: unknown): Generator<string> {
  if (typeof value === "string") {
    yield '"';
    for (let i = 0; i < value.length;) {
      let end = Math.min(i + STRING_CHARS, value.length);
      if (end < value.length && /[\uD800-\uDBFF]/.test(value[end - 1]!)) end--;
      yield JSON.stringify(value.slice(i, end)).slice(1, -1);
      i = end;
    }
    yield '"';
  } else if (value === null || typeof value !== "object") {
    yield JSON.stringify(value);
  } else if (Array.isArray(value)) {
    yield "[";
    for (let i = 0; i < value.length; i++) { if (i) yield ","; yield* canonicalChunks(value[i]); }
    yield "]";
  } else {
    yield "{";
    let first = true;
    for (const key of Object.keys(value).sort()) {
      if (!first) yield ",";
      first = false;
      yield* canonicalChunks(key); yield ":";
      yield* canonicalChunks((value as Record<string, unknown>)[key]);
    }
    yield "}";
  }
}

function* tokens(value: unknown): Generator<unknown[]> {
  if (typeof value === "string") {
    // JSON escaping preserves split surrogate pairs losslessly on decoding.
    for (let i = 0; i < value.length; i += STRING_CHARS) yield ["text", value.slice(i, i + STRING_CHARS)];
    yield ["string"];
  } else if (value === null || typeof value !== "object") yield ["value", value];
  else {
    yield [Array.isArray(value) ? "array" : "object"];
    if (Array.isArray(value)) for (const item of value) yield* tokens(item);
    else for (const [key, item] of Object.entries(value)) { yield* tokens(key); yield* tokens(item); }
    yield ["end"];
  }
}

export function* segmentedChunks(value: unknown): Generator<string> {
  yield MAGIC;
  for (const token of tokens(value)) yield `${JSON.stringify(token)}\n`;
}

export async function readBackupTransport(source: string, legacyMaxBytes: number): Promise<unknown> {
  const fail = (): never => { throw new Error("Harness state backup segment stream is invalid or incomplete."); };
  const stack: { value: unknown[] | Record<string, unknown>; key?: string }[] = [];
  let root: unknown;
  let hasRoot = false;
  let pieces: string[] = [];
  let pending = Buffer.alloc(0);
  let segmented: boolean | undefined;
  const legacy: Buffer[] = [];
  let legacyBytes = 0;
  const append = (value: unknown) => {
    const parent = stack.at(-1);
    if (!parent) { if (hasRoot) fail(); root = value; hasRoot = true; }
    else if (Array.isArray(parent.value)) parent.value.push(value);
    else if (parent.key === undefined) {
      if (typeof value !== "string" || Object.hasOwn(parent.value, value)) fail();
      parent.key = value as string;
    } else {
      Object.defineProperty(parent.value, parent.key, { value, enumerable: true, writable: true, configurable: true });
      delete parent.key;
    }
  };
  const consume = (line: Buffer) => {
    if (line.length > MAX_FRAME_BYTES) fail();
    const token: unknown = JSON.parse(line.toString("utf8"));
    if (!Array.isArray(token)) fail();
    const frame = token as unknown[];
    const [kind, value] = frame;
    if (kind === "text" && frame.length === 2 && typeof value === "string") { pieces.push(value); return; }
    if (kind === "string" && frame.length === 1) { append(pieces.join("")); pieces = []; return; }
    if (pieces.length) fail();
    if (kind === "value" && frame.length === 2 && (value === null || typeof value === "boolean" || typeof value === "number")) append(value);
    else if ((kind === "array" || kind === "object") && frame.length === 1) {
      if (stack.length >= 512) fail();
      const value = kind === "array" ? [] : {};
      append(value); stack.push({ value });
    } else if (kind === "end" && frame.length === 1) {
      const parent = stack.pop();
      if (!parent || parent.key !== undefined) fail();
    } else fail();
  };
  for await (const chunk of readRegularFileChunksNoFollow(source, {
    label: "Harness state backup", requireSingleLink: true, requirePrivate: true
  })) {
    pending = Buffer.concat([pending, chunk]);
    if (segmented === undefined) {
      if (pending.length < Buffer.byteLength(MAGIC)) continue;
      segmented = pending.subarray(0, MAGIC.length).toString() === MAGIC;
      if (segmented) pending = pending.subarray(MAGIC.length);
    }
    if (!segmented) {
      legacyBytes += pending.length;
      if (legacyBytes > legacyMaxBytes) throw new Error("Harness state backup exceeds the legacy size limit.");
      legacy.push(pending); pending = Buffer.alloc(0); continue;
    }
    let newline: number;
    while ((newline = pending.indexOf(10)) !== -1) {
      consume(pending.subarray(0, newline)); pending = pending.subarray(newline + 1);
    }
    if (pending.length > MAX_FRAME_BYTES) fail();
  }
  if (!segmented) {
    if (legacyBytes + pending.length > legacyMaxBytes) throw new Error("Harness state backup exceeds the legacy size limit.");
    return JSON.parse(Buffer.concat([...legacy, pending]).toString("utf8"));
  }
  if (pending.length || stack.length || pieces.length || !hasRoot) fail();
  return root;
}
