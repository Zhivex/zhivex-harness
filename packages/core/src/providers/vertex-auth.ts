import { GoogleAuth } from "google-auth-library";
import { createVertex } from "@zhivex-ai/vertex";
import { wrapLanguageModel, type StreamEvent } from "@zhivex-ai/core";
import { providerDiagnostic, providerDiagnosticSchema } from "../runtime/provider-diagnostics.js";
import {
  VERTEX_TRANSIENT_ATTEMPTS,
  isEmptyModelTurn,
  isRetryableProviderFailure,
  classifyProviderFailure,
  transientBackoffMs,
  type ProviderStatusCategory
} from "../runtime/provider-transient.js";
import type { GenerateResult } from "@zhivex-ai/core";

const CLOUD_PLATFORM_SCOPE = "https://www.googleapis.com/auth/cloud-platform";

export interface VertexRoute {
  readonly projectId: string;
  readonly location: string;
}

/** Reject malformed resource segments without including customer identifiers in errors. */
export function vertexRoute(env: NodeJS.ProcessEnv): VertexRoute {
  const projectId = (env.GOOGLE_CLOUD_PROJECT ?? "").trim();
  const location = (env.VERTEX_LOCATION ?? "").trim();
  if (!/^(?:[a-z][a-z0-9-]{4,61}[a-z0-9]|[0-9]{6,20})$/.test(projectId)) {
    throw new Error("Vertex requires a valid GOOGLE_CLOUD_PROJECT.");
  }
  if (!/^(?:global|us|eu|[a-z]+-[a-z]+[0-9]+)$/.test(location)) {
    throw new Error("Vertex requires an explicit valid VERTEX_LOCATION.");
  }
  return Object.freeze({ projectId, location });
}

/** Configuration presence only; does not assert ADC validity or contact Google. */
export function vertexConfigured(env: NodeJS.ProcessEnv): boolean {
  try { vertexRoute(env); return true; } catch { return false; }
}

export const VERTEX_ENVIRONMENT = ["GOOGLE_CLOUD_PROJECT", "VERTEX_LOCATION", "GOOGLE_APPLICATION_CREDENTIALS"] as const;
export function vertexEnvironment(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  return Object.fromEntries(VERTEX_ENVIRONMENT.flatMap(name => env[name] ? [[name, env[name]]] : []));
}

interface TokenSource { getAccessToken(): Promise<string | null | undefined>; }
type AuthFactory = (options: { projectId: string; scopes: string[]; keyFilename?: string }) => TokenSource;

/** ADC owns token caching/refresh. Never cache a bearer token in Harness configuration. */
export function vertexTokenSource(
  env: NodeJS.ProcessEnv,
  route: VertexRoute,
  createAuth: AuthFactory = options => new GoogleAuth(options)
): () => Promise<string> {
  const keyFilename = env.GOOGLE_APPLICATION_CREDENTIALS?.trim();
  const auth = createAuth({
    projectId: route.projectId,
    scopes: [CLOUD_PLATFORM_SCOPE],
    ...(keyFilename ? { keyFilename } : {})
  });
  return async () => {
    try {
      const token = await auth.getAccessToken();
      if (!token) throw new Error("Empty ADC token");
      return token;
    } catch {
      // Google errors may include service-account identities, file paths and tokens.
      // Do not attach the original cause; the public status remains actionable.
      throw new VertexAuthenticationError();
    }
  };
}

export class VertexAuthenticationError extends Error {
  readonly status = 401;
  readonly retryable = false;
  constructor() {
    super("Vertex ADC credentials are unavailable or could not be refreshed. Configure Application Default Credentials and retry.");
    this.name = "VertexAuthenticationError";
  }
}

export interface VertexRetryOptions {
  attempts?: number;
  delayMs?: (attempt: number) => number;
}

export function createVertexModel(
  model: string,
  env: NodeJS.ProcessEnv,
  createAuth?: AuthFactory,
  retry?: VertexRetryOptions
) {
  const route = vertexRoute(env);
  const adapter = createVertex({
    ...route,
    // Explicit callback takes precedence over SDK ambient static tokens/API keys.
    getAccessToken: vertexTokenSource(env, route, createAuth)
  })(model);
  const attempts = retry?.attempts ?? VERTEX_TRANSIENT_ATTEMPTS;
  const delayFor = (input: { retryBackoffMs?: number }) => retry?.delayMs ?? ((attempt: number) =>
    input.retryBackoffMs === 0 ? 0 : transientBackoffMs(attempt, input.retryBackoffMs ?? 250));
  // Retry on the inner model. Middleware next() may run only once per call.
  const generate = async (input: Parameters<typeof adapter.generate>[0]) =>
    withVertexAttempts(input.abortSignal, vertexAttemptBudget(input, attempts), delayFor(input), async () => {
      try { return await adapter.generate({ ...input, maxRetries: 0 }); } catch (error) { throw safeVertexError(error); }
    }, result => !isEmptyModelTurn(result));
  const innerStream = adapter.stream?.bind(adapter);
  const retrying = innerStream
    ? {
      ...adapter,
      generate,
      async stream(input: Parameters<typeof innerStream>[0]) {
        const events = await withVertexAttempts(input.abortSignal, vertexAttemptBudget(input, attempts), delayFor(input), () => collectVertexStream(() => innerStream({ ...input, maxRetries: 0 })), events => !isEmptyVertexStream(events));
        return replayVertexStream(events);
      }
    }
    : { ...adapter, generate };
  return wrapLanguageModel(retrying, [{
    name: "harness-vertex-sanitized-errors",
    async wrapGenerate(_context, next) {
      try { return await next(); } catch (error) { throw safeVertexError(error); }
    },
    async wrapStream(_context, next) {
      let stream: AsyncIterable<StreamEvent>;
      try { stream = await next(); } catch (error) { throw safeVertexError(error); }
      return (async function* () {
        try { yield* stream; } catch (error) { throw safeVertexError(error); }
      })();
    }
  }]);
}

async function collectVertexStream(next: () => Promise<AsyncIterable<StreamEvent>>): Promise<StreamEvent[]> {
  let stream: AsyncIterable<StreamEvent>;
  try { stream = await next(); } catch (error) { throw safeVertexError(error); }
  const events: StreamEvent[] = [];
  try {
    for await (const event of stream) {
      if (event.type === "error") throw safeVertexError(event.error);
      events.push(event);
    }
  } catch (error) {
    throw error instanceof Error && error.message.startsWith("Vertex request failed.") ? error : safeVertexError(error);
  }
  return events;
}

function isEmptyVertexStream(events: readonly StreamEvent[]): boolean {
  let text = "";
  let finishReason: GenerateResult["finishReason"];
  let tools = false;
  let media = false;
  for (const event of events) {
    if (event.type === "text-delta") text += event.textDelta;
    else if (event.type === "tool-call" || event.type === "tool-approval-request") tools = true;
    else if (event.type === "image-generation") media = true;
    else if (event.type === "finish") finishReason = event.finishReason;
  }
  return isEmptyModelTurn({
    text,
    finishReason,
    ...(tools ? { messages: [{ parts: [{ type: "tool-call" }] }] } : {}),
    ...(media ? { images: [{}] } : {})
  });
}

function replayVertexStream(events: readonly StreamEvent[]): AsyncIterable<StreamEvent> {
  return (async function* () { yield* events; })();
}

async function withVertexAttempts<T>(
  abortSignal: AbortSignal | undefined,
  attempts: number,
  delayMs: (attempt: number) => number,
  run: () => Promise<T>,
  accept: (value: T) => boolean
): Promise<T> {
  let last: T | undefined;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    if (abortSignal?.aborted) throw new DOMException("Vertex request cancelled.", "AbortError");
    try {
      const value = await run();
      if (accept(value) || attempt === attempts - 1) return value;
      last = value;
    } catch (error) {
      const safe = error instanceof Error && (error.name === "AbortError" || error.message.startsWith("Vertex request failed."))
        ? error
        : safeVertexError(error);
      if (safe.name === "AbortError" || abortSignal?.aborted || attempt === attempts - 1 || !isRetryableProviderFailure(safe)) throw safe;
    }
    await sleep(delayMs(attempt));
  }
  return last as T;
}

const sleep = (ms: number) => ms > 0 ? new Promise(resolve => setTimeout(resolve, ms)) : Promise.resolve();

/** Honor an explicit caller or task-budget cap. Unset requests get the bounded default. */
function vertexAttemptBudget(
  input: { maxRetries?: number; maxProviderRequests?: number },
  fallback: number
): number {
  const requested = [
    typeof input.maxProviderRequests === "number" ? input.maxProviderRequests : undefined,
    typeof input.maxRetries === "number" ? input.maxRetries + 1 : undefined
  ].filter((value): value is number => value !== undefined);
  if (requested.length === 0) return Math.max(1, fallback);
  return Math.max(1, Math.min(...requested));
}

function safeVertexError(error: unknown): Error {
  if (error instanceof VertexAuthenticationError) return error;
  const record = error && typeof error === "object" ? error as Record<string, unknown> : {};
  if (record.name === "AbortError") return new DOMException("Vertex request cancelled.", "AbortError");
  const failure = classifyProviderFailure(error);
  const body = providerBody(record.responseBody) ?? providerBody(record.body);
  const preserved = providerDiagnosticSchema.safeParse(record.provider);
  const provider = body !== undefined
    ? providerDiagnostic(body, failure.httpStatus)
    : preserved.success ? preserved.data : providerDiagnostic(undefined, failure.httpStatus);
  return Object.assign(new Error("Vertex request failed. Check the sanitized provider diagnosis."), {
    ...(failure.httpStatus !== undefined ? { status: failure.httpStatus } : {}),
    ...(failure.providerStatus ? { providerStatus: failure.providerStatus satisfies ProviderStatusCategory } : {}),
    provider,
    retryable: failure.retryable
  });
}

function providerBody(value: unknown): string | undefined {
  if (typeof value === "string") return value;
  if (!value || typeof value !== "object") return undefined;
  try { return JSON.stringify(value).slice(0, 8192); } catch { return undefined; }
}
