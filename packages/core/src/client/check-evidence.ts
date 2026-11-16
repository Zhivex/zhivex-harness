/** Redacted observation only: no argv, inputs, stdout, stderr or pass claims for a task. */
export function checkEvidence(results: readonly { toolName: string; output?: unknown; isError?: boolean }[]) {
  const receipts = results.flatMap(result => {
    if (!result.output || typeof result.output !== 'object' || Array.isArray(result.output)) return [];
    const output = result.output as Record<string, unknown>;
    const receipt = ['run_check', 'run_environment_command'].includes(result.toolName) ? output :
      result.toolName.startsWith('verify_and_apply_') && output.verification && typeof output.verification === 'object'
        ? output.verification as Record<string, unknown> : undefined;
    if (!receipt || !Number.isSafeInteger(receipt.exitCode) || typeof receipt.timedOut !== 'boolean') return [];
    return [{ toolName: result.toolName, exitCode: receipt.exitCode as number, timedOut: receipt.timedOut,
      passed: !result.isError && receipt.exitCode === 0 && !receipt.timedOut }];
  });
  return { coverage: 'recorded-checks-only' as const, receipts, passed: receipts.filter(receipt => receipt.passed).length,
    failed: receipts.filter(receipt => !receipt.passed).length, taskVerified: false as const };
}
