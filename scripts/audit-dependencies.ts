import { spawnSync } from "node:child_process";

export async function auditDependencies(
  run: () => { status: number | null; stdout: string; stderr: string },
  wait: (ms: number) => Promise<void>,
  log: (text: string) => void
): Promise<number> {
  for (let attempt = 1; attempt <= 3; attempt++) {
    const result = run();
    const output = result.stdout + result.stderr;
    log(output);
    if (result.status === 0) return 0;
    const unavailable = /error: POST https:\/\/registry\.npmjs\.org\/-\/npm\/v1\/security\/advisories\/bulk - (502|503|504)\b/.test(output);
    if (!unavailable || attempt === 3) return result.status ?? 1;
    log(`Audit registry unavailable; retry ${attempt + 1}/3.\n`);
    await wait(attempt * 5000);
  }
  return 1;
}

if (import.meta.main) {
  process.exitCode = await auditDependencies(
    () => spawnSync("bun", ["audit"], { encoding: "utf8" }),
    (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    (text) => process.stdout.write(text)
  );
}
