/** Fast-path engine check. Does not load the doctor or the engine. */
export const nodeEngineError = (version: string, range: string): string | undefined => {
  const minimumMatch = /^>=(\d+)\.(\d+)\.(\d+)$/.exec(range.trim());
  const actualMatch = /^(\d+)\.(\d+)\.(\d+)/.exec(version.trim());
  const failure = `Node.js ${version} does not satisfy the package engine requirement (${range}).\n`;
  if (!minimumMatch || !actualMatch) return failure;
  for (let index = 1; index <= 3; index += 1) {
    const actual = Number(actualMatch[index]);
    const minimum = Number(minimumMatch[index]);
    if (actual !== minimum) return actual > minimum ? undefined : failure;
  }
  return undefined;
};
