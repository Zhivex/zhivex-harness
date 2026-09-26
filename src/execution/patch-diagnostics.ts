import type { FileDigest } from "../workspace/edit-contracts.js";

/** Internal diagnostics only; never include patch bytes, paths or digest values. */
export class EnvironmentPatchDriftError extends Error {
  readonly diagnosticCode:
    | "OCI_PATCH_ID_MISMATCH"
    | "OCI_PATCH_SNAPSHOT_CHANGED"
    | "OCI_PATCH_REVIEW_UNAVAILABLE";

  constructor(expected: FileDigest, current: FileDigest, lastInspected: unknown) {
    super("Environment patch changed after review; inspect it again before import.");
    this.diagnosticCode = typeof lastInspected !== "string" || !/^sha256:[a-f0-9]{64}$/.test(lastInspected)
      ? "OCI_PATCH_REVIEW_UNAVAILABLE"
      : expected === lastInspected
        ? "OCI_PATCH_SNAPSHOT_CHANGED"
        : current === lastInspected
          ? "OCI_PATCH_ID_MISMATCH"
          : "OCI_PATCH_REVIEW_UNAVAILABLE";
  }
}
