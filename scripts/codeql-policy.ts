/** CodeQL init and analyze exchange version-specific configuration. */
export function validateCodeqlPins(workflow: string): string[] {
  const failures: string[] = [];
  const pins: string[] = [];
  for (const action of ["init", "analyze"]) {
    const matches = [...workflow.matchAll(new RegExp(`^\\s*(?:-\\s*)?uses:\\s*github/codeql-action/${action}@([^\\s#]+)`, "gm"))];
    if (matches.length !== 1 || !/^[a-f0-9]{40}$/.test(matches[0]?.[1] ?? "")) {
      failures.push(`CodeQL ${action} must appear once and be pinned to a full commit SHA.`);
    } else {
      pins.push(matches[0]![1]!);
    }
  }
  if (pins.length === 2 && pins[0] !== pins[1]) {
    failures.push("CodeQL init and analyze must use the same commit SHA; update them together.");
  }
  return failures;
}
