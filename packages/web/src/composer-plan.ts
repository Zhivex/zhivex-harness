/** What the composer should do with the current draft. The host session is created only for a real send. */
export type ComposerPlan = "ignore" | "need-credentials" | "create-and-start" | "start";

export function planComposerSend(state: {
  text: string;
  hasSession: boolean;
  noCredentials: boolean;
  canSend: boolean;
}): ComposerPlan {
  if (!state.canSend || state.text.trim().length === 0) return "ignore";
  if (state.noCredentials) return "need-credentials";
  return state.hasSession ? "start" : "create-and-start";
}

/** Host operations for a plan. The first message creates the session, then starts the task. */
export function composerHostActions(plan: ComposerPlan): Array<"create" | "start"> {
  if (plan === "create-and-start") return ["create", "start"];
  if (plan === "start") return ["start"];
  return [];
}
