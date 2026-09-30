import { GoogleAuth } from "google-auth-library";
import { createVertex } from "@zhivex-ai/vertex";
import { wrapLanguageModel, type StreamEvent } from "@zhivex-ai/core";
import { providerDiagnostic } from "../runtime/provider-diagnostics.js";

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

export function createVertexModel(model: string, env: NodeJS.ProcessEnv, createAuth?: AuthFactory) {
  const route = vertexRoute(env);
  const adapter = createVertex({
    ...route,
    // Explicit callback takes precedence over SDK ambient static tokens/API keys.
    getAccessToken: vertexTokenSource(env, route, createAuth)
  })(model);
  return wrapLanguageModel(adapter, [{
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

function safeVertexError(error: unknown): Error {
  if (error instanceof VertexAuthenticationError) return error;
  const record = error && typeof error === "object" ? error as Record<string, unknown> : {};
  if (record.name === "AbortError") return new DOMException("Vertex request cancelled.", "AbortError");
  const status = typeof record.status === "number" && Number.isInteger(record.status) && record.status >= 100 && record.status <= 599 ? record.status : undefined;
  return Object.assign(new Error("Vertex request failed. Check the sanitized provider diagnosis."), {
    ...(status ? { status } : {}),
    provider: providerDiagnostic(record.responseBody ?? record.body, status),
    retryable: record.retryable === true
  });
}
