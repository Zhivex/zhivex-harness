export const HARNESS_ERROR_CODES = [
  "CONFIG_INVALID",
  "CLI_USAGE_INVALID",
  "WORKSPACE_UNSAFE",
  "STATE_CONFLICT",
  "PROVIDER_UNAVAILABLE",
  "APPROVAL_REQUIRED",
  "EXECUTION_FAILED"
] as const;

export type HarnessErrorCode = (typeof HARNESS_ERROR_CODES)[number];
export type HarnessErrorCategory =
  | "configuration"
  | "usage"
  | "workspace"
  | "state"
  | "provider"
  | "approval"
  | "execution";

export interface HarnessErrorOptions {
  code: HarnessErrorCode;
  category: HarnessErrorCategory;
  retryable?: boolean;
  cause?: unknown;
}

export const HARNESS_ERROR_SCHEMA_VERSION = 1 as const;

export interface HarnessErrorDocument {
  schemaVersion: typeof HARNESS_ERROR_SCHEMA_VERSION;
  kind: "error";
  error: {
    code: HarnessErrorCode;
    category: HarnessErrorCategory;
    retryable: boolean;
  };
}

/** Stable machine-readable error base. Human-readable messages are not API. */
export class HarnessError extends Error {
  readonly code: HarnessErrorCode;
  readonly category: HarnessErrorCategory;
  readonly retryable: boolean;

  constructor(message: string, options: HarnessErrorOptions) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = "HarnessError";
    this.code = options.code;
    this.category = options.category;
    this.retryable = options.retryable ?? false;
  }
}

export class HarnessConfigError extends HarnessError {
  constructor(message: string, options: { cause?: unknown } = {}) {
    super(message, {
      code: "CONFIG_INVALID",
      category: "configuration",
      ...(options.cause === undefined ? {} : { cause: options.cause })
    });
    this.name = "HarnessConfigError";
  }
}

export class HarnessWorkspaceError extends HarnessError {
  constructor(message: string, options: { cause?: unknown } = {}) {
    super(message, {
      code: "WORKSPACE_UNSAFE",
      category: "workspace",
      ...(options.cause === undefined ? {} : { cause: options.cause })
    });
    this.name = "HarnessWorkspaceError";
  }
}

export class HarnessStateConflictError extends HarnessError {
  constructor(message: string, options: { cause?: unknown; retryable?: boolean } = {}) {
    super(message, {
      code: "STATE_CONFLICT",
      category: "state",
      retryable: options.retryable ?? false,
      ...(options.cause === undefined ? {} : { cause: options.cause })
    });
    this.name = "HarnessStateConflictError";
  }
}

export class HarnessProviderError extends HarnessError {
  constructor(message: string, options: { cause?: unknown; retryable?: boolean } = {}) {
    super(message, {
      code: "PROVIDER_UNAVAILABLE",
      category: "provider",
      retryable: options.retryable ?? true,
      ...(options.cause === undefined ? {} : { cause: options.cause })
    });
    this.name = "HarnessProviderError";
  }
}

export class HarnessApprovalError extends HarnessError {
  constructor(message: string, options: { cause?: unknown } = {}) {
    super(message, {
      code: "APPROVAL_REQUIRED",
      category: "approval",
      ...(options.cause === undefined ? {} : { cause: options.cause })
    });
    this.name = "HarnessApprovalError";
  }
}

export class HarnessExecutionError extends HarnessError {
  constructor(message: string, options: { cause?: unknown; retryable?: boolean } = {}) {
    super(message, {
      code: "EXECUTION_FAILED",
      category: "execution",
      retryable: options.retryable ?? false,
      ...(options.cause === undefined ? {} : { cause: options.cause })
    });
    this.name = "HarnessExecutionError";
  }
}

/**
 * Project an error onto the stable, redacted machine contract.
 *
 * Messages and causes are intentionally excluded: callers may show them to a
 * human, but neither is a compatibility contract and both can contain secrets.
 */
export const harnessErrorDocument = (error: unknown): HarnessErrorDocument => {
  const normalized = normalizeHarnessError(error);
  return {
    schemaVersion: HARNESS_ERROR_SCHEMA_VERSION,
    kind: "error",
    error: {
      code: normalized.code,
      category: normalized.category,
      retryable: normalized.retryable
    }
  };
};

const numericStatuses = (error: unknown) => {
  if (!error || typeof error !== "object") return undefined;
  const record = error as { status?: unknown; statusCode?: unknown };
  const values = [record.status, record.statusCode]
    .filter((value): value is number => typeof value === "number" && Number.isSafeInteger(value));
  return values.length > 0 ? values : undefined;
};

/** Normalize dependency/runtime failures without making messages contractual. */
export const normalizeHarnessError = (error: unknown): HarnessError => {
  if (error instanceof HarnessError) return error;
  const message = error instanceof Error ? error.message : "Harness execution failed.";
  const statuses = numericStatuses(error) ?? [];
  if (statuses.some((status) => status === 429 || (status >= 500 && status <= 599))) {
    return new HarnessProviderError(message, { cause: error, retryable: true });
  }
  const name = error && typeof error === "object" && typeof (error as { name?: unknown }).name === "string"
    ? (error as { name: string }).name
    : "";
  const code = error && typeof error === "object" && typeof (error as { code?: unknown }).code === "string"
    ? (error as { code: string }).code
    : "";
  if (name === "ConflictError" || code === "SQLITE_BUSY" || code === "SQLITE_LOCKED") {
    return new HarnessStateConflictError(message, {
      cause: error,
      retryable: code === "SQLITE_BUSY" || code === "SQLITE_LOCKED"
    });
  }
  return new HarnessExecutionError(message, { cause: error });
};
