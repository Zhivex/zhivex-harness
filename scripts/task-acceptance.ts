/** Live calls are opt-in. Always installs and identifies the exact supplied tarball. */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile, open } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { z } from "zod";
import { runPortableProcess } from "../src/execution/process-runtime.js";
import { ACCEPTANCE_FIXTURES, ACCEPTANCE_LIMITS, ACCEPTANCE_REVISION } from "./acceptance/fixtures.js";
import { fixtureDigest, runAcceptanceCase, summarizeAcceptance, type AcceptanceAttempt } from "./acceptance/runner.js";

assert.equal(process.env.ZHIVEX_HARNESS_LIVE, "1", "Set ZHIVEX_HARNESS_LIVE=1 for provider calls.");
const [tarballArg, reportArg, routesArg] = process.argv.slice(2);
assert(tarballArg && reportArg && routesArg, "Usage: bun scripts/task-acceptance.ts <tarball> <new-report.json> <routes.json>");
const tarball = path.resolve(tarballArg);
const reportPath = path.resolve(reportArg);
const identifier = z.string().min(1).max(160).regex(/^[a-zA-Z0-9][a-zA-Z0-9._:/-]*$/);
const routes = z.array(z.object({ provider: identifier, model: identifier, route: z.enum(["direct-api"]) }).strict()).min(1).max(10).parse(JSON.parse(await readFile(routesArg, "utf8")));
assert.equal(new Set(routes.map(r => `${r.provider}/${r.model}/${r.route}`)).size, routes.length, "Duplicate route");
const attempts = Number(process.env.ZHIVEX_ACCEPTANCE_ATTEMPTS ?? 1);
assert(Number.isInteger(attempts) && attempts >= 1 && attempts <= 3, "Attempts must be 1–3, fixed before execution.");
const artifactSha512 = `sha512-${createHash("sha512").update(await readFile(tarball)).digest("base64")}`;
const consumer = await mkdtemp(path.join(os.tmpdir(), "zhx-acceptance-consumer-"));
const rows: AcceptanceAttempt[] = [];
// Never overwrite previous campaign evidence. Each row is durably appended before the next call.
const journalPath = `${reportPath}.jsonl`;
await writeFile(reportPath, JSON.stringify({ status: "running", artifactSha512 }) + "\n", { flag: "wx", mode: 0o600 });
try {
  await writeFile(journalPath, "", { flag: "wx", mode: 0o600 });
  await writeFile(path.join(consumer, "package.json"), '{"private":true,"type":"module"}');
  const install = await runPortableProcess(["bun", "add", "--ignore-scripts", tarball], { cwd: consumer, timeoutMs: 120_000 });
  assert.equal(install.exitCode, 0, "Tarball installation failed");
  const packageRoot = path.join(consumer, "node_modules/@zhivex-ai/harness");
  const manifest = JSON.parse(await readFile(path.join(packageRoot, "package.json"), "utf8"));
  const api: typeof import("../src/engine/index.js") = await import(pathToFileURL(path.join(packageRoot, "dist/engine/index.js")).href);
  for (const route of routes) {
    assert(api.PROVIDERS.includes(route.provider as typeof api.PROVIDERS[number]), "Route not installed");
    const availability = api.providerAvailability().find(p => p.id === route.provider)!;
    assert(!availability.configuration.customEndpoint, "direct-api requires the provider default endpoint");
  }
  for (const route of routes) for (const fixture of ACCEPTANCE_FIXTURES) {
    for (let attempt = 1; attempt <= attempts; attempt++) {
      const row = await runAcceptanceCase(api, fixture, route, attempt);
      rows.push(row);
      const journal = await open(journalPath, "a");
      try {
        await journal.writeFile(JSON.stringify({ artifactSha512, revision: ACCEPTANCE_REVISION, ...row }) + "\n");
        await journal.sync();
      } finally { await journal.close(); }
      process.stdout.write(`${route.provider}/${fixture.id} attempt ${attempt}: ${row.status}\n`);
      if (row.status !== "failed") break;
    }
  }
  const summary = summarizeAcceptance(rows, routes.length * ACCEPTANCE_FIXTURES.length);
  await writeFile(reportPath, JSON.stringify({ schemaVersion: 1, kind: "common-task-acceptance", evidence: "installed-live",
    artifact: { name: manifest.name, version: manifest.version, sha512: artifactSha512 },
    revision: ACCEPTANCE_REVISION, fixtureSha256: fixtureDigest(ACCEPTANCE_FIXTURES),
    observedAt: new Date().toISOString(), limits: ACCEPTANCE_LIMITS, maximumAttempts: attempts,
    thresholds: { requiredFirstAttemptPassRate: 1, protectedFileChanges: 0, incompletePasses: 0 },
    ...summary, rows, limitations: ["Not protected release certification", "Scripted fixture approvals and user corrections are not independent human review", "Cost remains null without verified pricing", "Small disposable tasks; no competitive benchmark"] }, null, 2) + "\n");
  if (summary.status !== "passed") process.exitCode = 1;
} catch (error) {
  // Preserve rows on interruption/setup failure without disclosing install output or provider secrets.
  await writeFile(reportPath, JSON.stringify({ status: "failed", artifactSha512, rows, diagnostic: "CAMPAIGN_INTERRUPTED_OR_SETUP_FAILED" }, null, 2) + "\n");
  process.stderr.write("Acceptance campaign failed; preserved report and attempt journal.\n");
  process.exitCode = 1;
} finally { await rm(consumer, { recursive: true, force: true }); }
