/** Check executable installation pins and stale release claims in first-run guides.
 * Historical changelogs/reports are intentionally outside this scope.
 */
export function checkOnboardingDocument(file: string, contents: string, version: string): string[] {
  const failures: string[] = [];
  for (const [index, line] of contents.split(/\r?\n/).entries()) {
    for (const match of line.matchAll(/@zhivex-ai\/harness@([^\s`"'<>;)]+)/g)) {
      if (match[1] !== version) {
        failures.push(`${file}:${index + 1}: installation pin ${match[1]} must be ${version}`);
      }
    }
    if (/\b(?:published RC\.\d+ (?:also )?adds|What RC\.\d+ adds|1\.0`? candidate|not yet published or live-certified)\b/i.test(line) ||
        /Support in `latest` \(`0\./.test(line)) {
      failures.push(`${file}:${index + 1}: stale prerelease or support claim in onboarding`);
    }
  }
  return failures;
}

export function checkStableRoadmap(contents: string, version: string): string[] {
  const row = contents.split(/\r?\n/).find((line) => line.startsWith(`| \`${version}\` |`));
  return row?.includes('Published on npm as `latest`')
    ? [] : [`ROADMAP.md: ${version} must be listed as published on npm as latest`];
}
