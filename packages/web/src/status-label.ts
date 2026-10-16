/** One English name per run state. Raw enums stay out of the surface. */
export function runStatusLabel(status: string | undefined): string {
  switch (status) {
    case "waiting_approval": return "Needs you";
    case "completed": return "Done";
    case "failed":
    case "timed_out": return "Error";
    case "cancelled": return "Cancelled";
    case "running":
    case "created":
    case "queued": return "Running";
    case "cancel_requested": return "Cancel requested";
    case undefined: return "Ready";
    default: return "Ready";
  }
}

export function sessionStatusLabel(status: string | undefined, outOfDate: boolean): string {
  if (outOfDate && status === "waiting_approval") return "Out of date";
  return runStatusLabel(status);
}
