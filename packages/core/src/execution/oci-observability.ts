import { channel } from "node:diagnostics_channel";

const diagnostics = channel("zhivex.harness.oci.phase");
let sequence = 0;
/** Internal diagnostics contain only fixed operation labels and numeric correlation. */
export async function observeOciPhase<T>(operation: "oci_inspect" | "oci_create" | "oci_execute" | "oci_export" | "oci_cleanup", action: () => Promise<T>): Promise<T> {
  if (!diagnostics.hasSubscribers) return action();
  const id = ++sequence;
  diagnostics.publish({ id, operation, outcome: "running" });
  try {
    const result = await action();
    const timedOut = !!result && typeof result === "object" && "timedOut" in result && result.timedOut === true;
    diagnostics.publish({ id, operation, outcome: timedOut ? "failed" : "completed", timedOut });
    return result;
  } catch (error) {
    diagnostics.publish({ id, operation, outcome: "failed" });
    throw error;
  }
}
