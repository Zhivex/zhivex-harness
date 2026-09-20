import type { ToolSet } from "@zhivex-ai/core";

/** Private local debugging only. Never include these records in benchmark reports.
 * The verifier has already crossed its ordinary approval boundary when execute runs.
 */
export type VerifierFailureObserver = (record: {
  command: string; args: string[]; exitCode: number; timedOut: boolean;
  stdout: string; stderr: string;
}) => void;

export function observeVerifierFailures(tools: ToolSet, observer?: VerifierFailureObserver): ToolSet {
  if (!observer) return tools;
  const name = "verify_and_apply_environment_patch";
  const tool = tools[name];
  if (!tool || !("execute" in tool)) return tools;
  let captured = 0;
  return { ...tools, [name]: { ...tool, async execute(input, context) {
    try { return await tool.execute(input, context); }
    catch (error) {
      // Never inspect arbitrary error messages, process environment or provider data.
      const verification = (error as { verification?: { exitCode?: unknown; timedOut?: unknown;
        diagnostics?: { stdout?: unknown; stderr?: unknown } } } | null)?.verification;
      const request = input as { command?: unknown; args?: unknown };
      if (captured < 3 && Number.isSafeInteger(verification?.exitCode) && typeof request.command === "string" &&
        Array.isArray(request.args) && request.args.every(arg => typeof arg === "string")) {
        captured++;
        try { observer({ command: request.command, args: [...request.args], exitCode: verification!.exitCode as number,
          timedOut: verification!.timedOut === true,
          stdout: typeof verification!.diagnostics?.stdout === "string" ? verification!.diagnostics.stdout.slice(0, 2048) : "",
          stderr: typeof verification!.diagnostics?.stderr === "string" ? verification!.diagnostics.stderr.slice(0, 2048) : "" }); }
        catch { /* Diagnostics cannot replace the original failure or execution outcome. */ }
      }
      throw error;
    }
  } } };
}
