const rejectedModelCodes = new Set([
  "WEB_MODEL_CHANGE_BUSY",
  "WEB_MODEL_CHANGE_IN_PROGRESS",
  "WEB_MODEL_NOT_CONFIGURED",
  "WEB_CREDENTIALS_REQUIRED",
]);
const record = (value: unknown): Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown> : {};

/** A host-confirmed rejection before selecting/replacing any model owner. */
export class ModelSelectionRejectedError extends Error {}

export function modelSelectionRejection(
  route: string, value: unknown, status: number, document: unknown,
): ModelSelectionRejectedError | undefined {
  const fault = record(document), code = record(fault.error).code;
  if (route === "action" && record(value).action === "selectModel" &&
    status >= 400 && status < 500 && fault.ok === false &&
    typeof code === "string" && rejectedModelCodes.has(code)) {
    return new ModelSelectionRejectedError(code);
  }
}
