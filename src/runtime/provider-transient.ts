/**
 * Closed categories for transient Vertex/Google failures.
 * Sanitized diagnostics may record one of these labels and an HTTP status.
 * They must not record provider messages, resource names, or credentials.
 */
export const PROVIDER_STATUS_CATEGORIES = [
  "ABORTED",
  "RESOURCE_EXHAUSTED",
  "UNAVAILABLE",
  "DEADLINE_EXCEEDED",
  "INTERNAL",
  "STREAM_RESET"
] as const;

export type ProviderStatusCategory = (typeof PROVIDER_STATUS_CATEGORIES)[number];

export const VERTEX_TRANSIENT_ATTEMPTS = 3;

const TRANSIENT_HTTP: Readonly<Record<number, ProviderStatusCategory>> = {
  408: "DEADLINE_EXCEEDED",
  409: "ABORTED",
  425: "UNAVAILABLE",
  429: "RESOURCE_EXHAUSTED",
  500: "INTERNAL",
  502: "UNAVAILABLE",
  503: "UNAVAILABLE",
  504: "DEADLINE_EXCEEDED"
};

/** gRPC status codes from the Vertex/Google client. HTTP statuses are 100–599 and do not overlap. */
const TRANSIENT_GRPC: Readonly<Record<number, ProviderStatusCategory>> = {
  4: "DEADLINE_EXCEEDED",
  8: "RESOURCE_EXHAUSTED",
  10: "ABORTED",
  13: "INTERNAL",
  14: "UNAVAILABLE"
};

const CATEGORY_HTTP: Readonly<Record<ProviderStatusCategory, number | undefined>> = {
  ABORTED: 409,
  RESOURCE_EXHAUSTED: 429,
  UNAVAILABLE: 503,
  DEADLINE_EXCEEDED: 504,
  INTERNAL: 500,
  STREAM_RESET: undefined
};

const SYMBOLIC = new Set<string>(["ABORTED", "RESOURCE_EXHAUSTED", "UNAVAILABLE", "DEADLINE_EXCEEDED", "INTERNAL"]);
const STREAM_RESET_CODES = new Set(["ECONNRESET", "ECONNABORTED", "EPIPE", "ETIMEDOUT", "UND_ERR_SOCKET", "ERR_STREAM_PREMATURE_CLOSE"]);
const HTTP_IN_MESSAGE = /(?:^|[^\d])(408|409|425|429|500|502|503|504)(?=$|[^\d])/;
const STREAM_RESET_MESSAGE = /stream reset|RST_STREAM|ECONNRESET|socket hang up|ERR_STREAM_PREMATURE_CLOSE|UND_ERR_SOCKET/i;

export interface ProviderFailureClassification {
  retryable: boolean;
  httpStatus?: number;
  providerStatus?: ProviderStatusCategory;
}

const isProviderStatus = (value: unknown): value is ProviderStatusCategory =>
  typeof value === "string" && (PROVIDER_STATUS_CATEGORIES as readonly string[]).includes(value);

const httpStatusValue = (value: unknown): number | undefined =>
  typeof value === "number" && Number.isInteger(value) && value >= 100 && value <= 599 ? value : undefined;

const definitiveClientStatus = (status: number | undefined) =>
  status !== undefined && status >= 400 && status < 500 && TRANSIENT_HTTP[status] === undefined;

/** Signals on one error object. Cause walking is owned by classifyProviderFailure. */
export function readProviderFailureRecord(record: Record<string, unknown>, depth = 0): ProviderFailureClassification {
  let retryable = false;
  let clientError = false;
  let httpStatus: number | undefined;
  let providerStatus: ProviderStatusCategory | undefined;
  const noteHttp = (status: number | undefined) => {
    if (status === undefined) return;
    httpStatus ??= status;
    const category = TRANSIENT_HTTP[status];
    if (category) {
      retryable = true;
      providerStatus ??= category;
    } else if (status >= 400 && status < 500) clientError = true;
  };
  const noteCategory = (category: ProviderStatusCategory | undefined) => {
    if (!category || clientError) return;
    retryable = true;
    providerStatus ??= category;
    if (httpStatus === undefined) httpStatus = CATEGORY_HTTP[category];
  };
  const absorb = (value: unknown) => {
    if (depth >= 2 || !value || typeof value !== "object" || value === record) return;
    const signals = readProviderFailureRecord(value as Record<string, unknown>, depth + 1);
    noteHttp(signals.httpStatus);
    noteCategory(signals.providerStatus);
  };

  noteHttp(httpStatusValue(record.status) ?? httpStatusValue(record.statusCode) ?? httpStatusValue(record.httpStatusCode));
  if (typeof record.status === "string" && /^\d{3}$/.test(record.status)) noteHttp(Number(record.status));
  if (typeof record.code === "number" && record.code >= 100 && record.code <= 599) noteHttp(record.code);
  if (typeof record.code === "number" && record.code >= 0 && record.code <= 16) noteCategory(TRANSIENT_GRPC[record.code]);
  if (typeof record.code === "string") {
    if (STREAM_RESET_CODES.has(record.code)) noteCategory("STREAM_RESET");
    else if (SYMBOLIC.has(record.code)) noteCategory(record.code as ProviderStatusCategory);
  }
  if (typeof record.status === "string" && SYMBOLIC.has(record.status)) noteCategory(record.status as ProviderStatusCategory);
  if (isProviderStatus(record.providerStatus)) noteCategory(record.providerStatus);
  if (record.diagnosticCode === "VERTEX_STREAM_TOOL_TRUNCATED" || record.reason === "stream_truncated") noteCategory("STREAM_RESET");
  if (record.code === "PROVIDER_UNAVAILABLE" && record.retryable === true) retryable = true;
  const body = record.responseBody ?? record.body;
  if (!clientError) {
    if (typeof body === "string") noteCategory(categoryFromBody(body));
    else absorb(body);
    absorb(record.error);
  }
  if (!retryable && !clientError && typeof record.message === "string") {
    const match = record.message.match(HTTP_IN_MESSAGE);
    if (match?.[1]) noteHttp(Number(match[1]));
    else if (STREAM_RESET_MESSAGE.test(record.message)) noteCategory("STREAM_RESET");
  }
  if (httpStatus !== undefined && definitiveClientStatus(httpStatus)) return { retryable: false, httpStatus };
  return { retryable, ...(httpStatus !== undefined ? { httpStatus } : {}), ...(providerStatus ? { providerStatus } : {}) };
}

function categoryFromBody(body: string): ProviderStatusCategory | undefined {
  if (Buffer.byteLength(body) > 8192) return undefined;
  try {
    const parsed: unknown = JSON.parse(body);
    if (!parsed || typeof parsed !== "object") return undefined;
    const detail = (parsed as { error?: unknown }).error;
    const source = detail && typeof detail === "object" ? detail as Record<string, unknown> : parsed as Record<string, unknown>;
    return readProviderFailureRecord(source).providerStatus;
  } catch {
    return undefined;
  }
}

/** Walk a Vertex/Google error chain without retaining its message or payload. */
export function classifyProviderFailure(error: unknown): ProviderFailureClassification {
  if (error && typeof error === "object") {
    const top = readProviderFailureRecord(error as Record<string, unknown>);
    if (top.httpStatus !== undefined && definitiveClientStatus(top.httpStatus)) return { retryable: false, httpStatus: top.httpStatus };
  }
  const seen = new Set<object>();
  let retryable = false;
  let httpStatus: number | undefined;
  let providerStatus: ProviderStatusCategory | undefined;
  const visit = (current: unknown, depth: number) => {
    if (!current || typeof current !== "object" || depth > 5 || seen.has(current)) return;
    seen.add(current);
    const record = current as Record<string, unknown>;
    const signals = readProviderFailureRecord(record);
    httpStatus ??= signals.httpStatus;
    providerStatus ??= signals.providerStatus;
    if (httpStatus !== undefined && providerStatus === undefined) providerStatus = TRANSIENT_HTTP[httpStatus];
    // An explicit opt-out stays non-retryable and hides nested transport status.
    if (record.retryable === false) return;
    if (signals.retryable) retryable = true;
    visit(record.cause, depth + 1);
    if (record.error && typeof record.error === "object") visit(record.error, depth + 1);
    if (record.details && typeof record.details === "object") visit(record.details, depth + 1);
    if (Array.isArray(record.chain)) for (const entry of record.chain) visit(entry, depth + 1);
  };
  visit(error, 0);
  if (retryable && httpStatus === undefined && providerStatus) httpStatus = CATEGORY_HTTP[providerStatus];
  return { retryable, ...(httpStatus !== undefined ? { httpStatus } : {}), ...(providerStatus ? { providerStatus } : {}) };
}

export function isRetryableProviderFailure(error: unknown): boolean {
  return classifyProviderFailure(error).retryable;
}

/** Full jitter on a capped exponential delay. Attempt 0 is the first retry. */
export function transientBackoffMs(attempt: number, baseMs = 250): number {
  const exponential = Math.min(baseMs * 2 ** Math.max(0, attempt), 10_000);
  return exponential + Math.floor(Math.random() * exponential);
}

const thoughtOnlyText = (text: string): boolean => {
  try {
    const parsed: unknown = JSON.parse(text);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return false;
    const record = parsed as Record<string, unknown>;
    return record.thought === true && Object.keys(record).every(key => key === "thought" || key === "thoughtSignature");
  } catch {
    return false;
  }
};

/** A model turn the caller cannot act on: no visible text and no tool call. */
export function isEmptyModelTurn(result: {
  text?: string;
  finishReason?: unknown;
  messages?: readonly { parts?: readonly { type?: string; text?: string }[] }[];
  images?: readonly unknown[];
  audio?: readonly unknown[];
}): boolean {
  if (result.finishReason === "content-filter" || result.finishReason === "error") return false;
  if ((result.images?.length ?? 0) > 0 || (result.audio?.length ?? 0) > 0) return false;
  const parts = result.messages?.flatMap(message => message.parts ?? []) ?? [];
  if (parts.some(part => part.type === "tool-call" || part.type === "image" || part.type === "audio")) return false;
  const texts = [result.text ?? "", ...parts.filter(part => part.type === "text").map(part => part.text ?? "")];
  return texts.every(text => text.trim().length === 0 || thoughtOnlyText(text.trim()));
}
