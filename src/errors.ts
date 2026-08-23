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
