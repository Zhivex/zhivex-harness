import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { describe, expect, test } from "bun:test";
import { REPRESENTATIVE_DATASET_NAME, REPRESENTATIVE_DATASET_REVISION } from "../scripts/generate-representative-evidence.js";

type WorkflowStep = { id?: string; name?: string; run?: string; if?: string; env?: Record<string, string>; with?: Record<string, unknown>; uses?: string };
type Workflow = { jobs: Record<string, { needs?: string | string[]; if?: string; env: Record<string, string>; steps: WorkflowStep[] }> };
const readWorkflow = async (name: string) => Bun.YAML.parse(await readFile(path.join(workspace, ".github/workflows", name), "utf8")) as Workflow;
const candidateModels = async () => {
  const manifest = JSON.parse(await readFile(path.join(workspace, "package.json"), "utf8"));
  const matrix = JSON.parse(await readFile(path.join(workspace, "evaluations/representative-assembly-matrix.json"), "utf8"));
  const entry = matrix.expectedModels.find((row: { releaseTag: string }) => row.releaseTag === `v${manifest.version}`);
  expect(entry).toBeDefined();
  return entry.models as Record<string, string>;
};

const workspace = path.resolve(import.meta.dir, "..");
test('manual certification covers the release live gates, model pins, route credentials and Vertex authentication', async () => {
  const release = (await readWorkflow('release.yml')).jobs['certify-live']!;
  const manualWorkflow = await readWorkflow('live-certification.yml');
  const manual = manualWorkflow.jobs.certify!;
  const yaml = Bun.YAML.parse(await readFile(path.join(workspace, '.github/workflows/live-certification.yml'), 'utf8')) as {
    on: {workflow_dispatch: {inputs: {providers: {default: string}}}}; permissions: Record<string,string>
  };
  expect(yaml.on.workflow_dispatch.inputs.providers.default).toBe(release.env.ZHIVEX_HARNESS_LIVE_PROVIDERS!);
  expect(yaml.permissions['id-token']).toBe('write');
  for (const [key, value] of Object.entries(release.env)) {
    if (key.endsWith('_MODEL') || key.startsWith('VERTEX_') || key === 'GOOGLE_CLOUD_PROJECT') expect(manual.env[key]).toBe(value);
  }
  const releaseGates = release.steps.filter(step => step.id?.startsWith('live_'));
  const manualGates = manual.steps.filter(step => step.id?.startsWith('live_') && step.id !== 'live_config');
  expect(manualGates.map(step => step.id)).toEqual(releaseGates.map(step => step.id));
  for (const step of releaseGates) {
    const target = manualGates.find(row => row.id === step.id)!;
    expect(target.run).toBe(step.run);
    expect(target.env).toEqual(step.env);
  }
  const auth = manual.steps.find(step => step.uses?.startsWith('google-github-actions/auth@'))!;
  expect(auth.with).toEqual(release.steps.find(step => step.uses?.startsWith('google-github-actions/auth@'))!.with);
  const config = manual.steps.find(step => step.id === 'live_config')!;
  expect(config.env!.ZHIVEX_HARNESS_LIVE_PROVIDERS).toBe(release.env.ZHIVEX_HARNESS_LIVE_PROVIDERS!);
});
test("six-route release gates require configuration, OIDC and every acceptance boundary", async () => {
  const workflow = await readWorkflow("release.yml");
  const job = workflow.jobs["certify-live"]!;
  expect(job.env.ZHIVEX_HARNESS_LIVE_PROVIDERS!.split(",").sort()).toEqual(["anthropic", "gemini", "meta", "openai", "qwen", "vertex"]);
  const steps = job.steps;
  const config = steps.findIndex(step => step.run?.includes("check-live-release-config.ts"));
  const auth = steps.findIndex(step => step.uses?.startsWith("google-github-actions/auth@"));
  expect(config).toBeGreaterThanOrEqual(0);
  expect(auth).toBeGreaterThan(config);
  expect(steps[auth]!.uses).toMatch(/@[a-f0-9]{40}$/);
  expect(steps[auth]!.with?.create_credentials_file).toBe(true);
  const enforce = steps.find(step => step.name === "Enforce complete live certification result")!;
  for (const id of ["base", "compaction", "orchestration", "execution", "continuity", "routing_vertex", "routing_anthropic", "routing_gemini", "routing_meta"]) {
    const index = steps.findIndex(step => step.id === `live_${id}`);
    expect(index).toBeGreaterThan(auth);
    expect(steps[index]!.if).toBeUndefined();
    expect(enforce.run).toContain(`steps.live_${id}.outcome`);
  }
  expect(steps.find(step => step.id === "live_compaction")!.env!.ZHIVEX_HARNESS_LIVE_APPROVAL_COMPACTION).toBe("1");
  expect(steps.find(step => step.id === "live_orchestration")!.env!.ZHIVEX_HARNESS_LIVE_STRUCTURED_DELEGATION).toBe("1");
  for (const reviewer of ["vertex", "anthropic", "gemini", "meta"]) {
    const env = steps.find(step => step.id === `live_routing_${reviewer}`)!.env!;
    expect(env.ZHIVEX_HARNESS_LIVE_REVIEWER_PROVIDER).toBe(reviewer);
    expect(env.ZHIVEX_HARNESS_LIVE_PARENT_PROVIDER).toBe(reviewer === "meta" ? "qwen" : "openai");
  }
});
const workflowPaths = [
  ".github/workflows/release.yml",
  ".github/workflows/live-certification.yml"
] as const;

describe("release workflow version source", () => {
  test("actual release readiness accepts the candidate workflow and dataset", async () => {
    const child = Bun.spawn([process.execPath, "run", "scripts/check-release-readiness.ts"], {
      cwd: workspace,
      // Exercise local checks in PR CI without claiming this checkout is main.
      env: { ...process.env, GITHUB_ACTIONS: "false" },
      stdin: "ignore", stdout: "pipe", stderr: "pipe"
    });
    const [stdout, stderr, code] = await Promise.all([
      new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited
    ]);
    if (code === 0) {
      expect(stdout).toContain("Release readiness passed");
      return;
    }
    expect(stderr).toContain("Release readiness check failed:");
    const failures = stderr.split("\n").filter(line => line.startsWith("- "));
    expect(failures.length).toBeGreaterThan(0);
    // A contributor checkout may be dirty or on a branch; every metadata and
    // workflow contract must still pass before reaching the protected release.
    expect(failures.filter(line => line !== "- Git worktree is not clean" &&
      !line.startsWith("- release checks must run from main, not "))).toEqual([]);
  });

  test("release stops remaining paid gates while preserving aggregate enforcement and diagnostics", async () => {
    const workflow = await readFile(path.join(workspace, ".github/workflows/release.yml"), "utf8");
    expect(workflow).not.toContain("continue-on-error:");
    expect(workflow).toContain('ZHIVEX_HARNESS_LIVE_FAIL_FAST: "1"');
    expect(workflow).toContain("needs: [validate, certify-live]");
    expect(workflow).toContain("needs.certify-live.result == 'success'");
    for (const name of ["Evaluate Meta", "Evaluate Qwen", "Evaluate OpenAI"]) {
      const block = workflow.match(new RegExp(`- name: ${name}[^\\n]*\\n([\\s\\S]*?)(?=\\n      - name:)`))?.[0];
      expect(block).toBeDefined();
      expect(block).not.toContain("if:"); // GitHub's implicit success() skips after failure.
    }
    for (const name of ["Enforce complete representative result", "Upload sanitized representative diagnostics", "Enforce complete live certification result", "Upload sanitized live diagnostics"]) {
      expect(workflow).toContain(`- name: ${name}\n        if: \${{ always() }}`);
    }
    const manual = await readFile(path.join(workspace, ".github/workflows/live-certification.yml"), "utf8");
    expect(manual).not.toContain("ZHIVEX_HARNESS_LIVE_FAIL_FAST");
    expect(manual).toContain("continue-on-error: true");
  });
  for (const workflowPath of workflowPaths) {
    test(`${workflowPath} requires a tag without duplicating the package version`, async () => {
      const workflow = await readFile(path.join(workspace, workflowPath), "utf8");

      expect(workflow).toContain(
        "description: Annotated vX.Y.Z or vX.Y.Z-rc.N tag; must match package.json and resolve to main"
      );
      expect(workflow).toContain("required: true");
      expect(workflow).toContain("ref: ${{ inputs.tag }}");
      expect(workflow).not.toMatch(/default:\s+v\d+\.\d+\.\d+/);
    });
  }

  test("CI verifies the built version against package.json without a duplicate literal", async () => {
    const workflow = await readFile(path.join(workspace, ".github/workflows/ci.yml"), "utf8");

    expect(workflow).toContain('const expected = require("./package.json").version');
    expect(workflow).not.toMatch(/HARNESS_VERSION !== "\d+\.\d+\.\d+"/);
  });

  test("CI and Dependabot cover the desktop dependency boundary", async () => {
    const [workflow, dependabot] = await Promise.all([
      readFile(path.join(workspace, ".github/workflows/ci.yml"), "utf8"),
      readFile(path.join(workspace, ".github/dependabot.yml"), "utf8")
    ]);

    expect(workflow).toContain("desktop-security:");
    expect(workflow).toContain("bun install --cwd desktop --frozen-lockfile --ignore-scripts");
    expect(workflow).toContain("working-directory: desktop");
    expect(workflow).toContain("bun test desktop/tests");
    expect(workflow).toContain("bun run --cwd desktop package");
    expect(workflow).toContain("bun run --cwd desktop smoke:packaged --empty-start");
    expect(dependabot).toMatch(/package-ecosystem: bun\n\s+directory: \/desktop/);
  });

  test("macOS CI prepares the Electron binary before native tests", async () => {
    const workflow = Bun.YAML.parse(await readFile(path.join(workspace, ".github/workflows/ci.yml"), "utf8")) as {
      jobs: Record<string, { steps: { name: string; run?: string; if?: string }[] }>;
    };
    for (const [job, testCommand] of [["desktop-security", "bun test desktop/tests"], ["verify", "bun run check"]] as const) {
      const steps = workflow.jobs[job]!.steps;
      const installIndex = steps.findIndex(step => step.run?.includes("node desktop/node_modules/electron/install.js"));
      const testIndex = steps.findIndex(step => step.run?.includes(testCommand));
      expect(installIndex).toBeGreaterThanOrEqual(0);
      expect(testIndex).toBeGreaterThan(installIndex);
      expect(steps.slice(0, installIndex + 1).some(step =>
        step.run?.includes("bun install --cwd desktop --frozen-lockfile --ignore-scripts"))).toBe(true);
      if (job === "verify") expect(steps[installIndex]!.if).toBe("runner.os == 'macOS'");
    }
  });

  test("full-suite jobs install Desktop renderer dependencies on every platform", async () => {
    for (const [file, job, command] of [
      ["ci.yml", "verify", "bun run check"],
      ["release.yml", "validate", "bun run release:check"],
    ] as const) {
      const workflow = Bun.YAML.parse(await readFile(path.join(workspace, ".github/workflows", file), "utf8")) as {
        jobs: Record<string, { steps: { run?: string; if?: string }[] }>;
      };
      const steps = workflow.jobs[job]!.steps;
      const testIndex = steps.findIndex(step => step.run?.includes(command));
      const installIndex = steps.findIndex(step =>
        step.run?.includes("bun install --cwd desktop --frozen-lockfile --ignore-scripts"));
      expect(installIndex).toBeGreaterThanOrEqual(0);
      expect(testIndex).toBeGreaterThan(installIndex);
      expect(steps[installIndex]!.if).toBeUndefined();
    }
  });

  test("release artifact transfer actions are pinned to immutable commit SHAs", async () => {
    const workflow = await readFile(path.join(workspace, ".github/workflows/release.yml"), "utf8");

    expect(workflow).toMatch(/actions\/upload-artifact@[a-f0-9]{40}(?:\s|$)/);
    expect(workflow).toMatch(/actions\/download-artifact@[a-f0-9]{40}(?:\s|$)/);
  });

  test("release validation binds stable and prerelease versions to the correct npm channel", async () => {
    const workflow = await readFile(path.join(workspace, ".github/workflows/release.yml"), "utf8");

    expect(workflow).toContain('--channel "$RELEASE_CHANNEL"');
    expect(workflow).toContain("RELEASE_CHANNEL: ${{ inputs.channel }}");
  });

  test("release validation can verify recorded GitHub workflow evidence", async () => {
    const workflow = await readFile(path.join(workspace, ".github/workflows/release.yml"), "utf8");

    expect(workflow).toContain("actions: read");
    expect(workflow).toContain("GITHUB_TOKEN: ${{ github.token }}");
  });

  test("release readiness invokes the fail-closed GA promotion gate for 1.0.0", async () => {
    const readiness = await readFile(path.join(workspace, "scripts/check-release-readiness.ts"), "utf8");

    expect(readiness).toContain('manifest.version === "1.0.0"');
    expect(readiness).toContain('["bun", "run", "readiness:1.0:release"]');
  });

  test("publication requires complete artifact-bound representative evidence", async () => {
    const workflow = await readWorkflow("release.yml");
    const publication = workflow.jobs.publish!;
    expect(publication.needs).toEqual(["validate", "certify-live", "representative-evaluation"]);
    for (const gate of publication.needs!) expect(publication.if).toContain(`needs.${gate}.result == 'success'`);
    const representative = workflow.jobs["representative-evaluation"]!;
    expect(representative.needs).toEqual(["validate", "certify-live"]);
    expect(representative.env.REPRESENTATIVE_DATASET_NAME).toBe(REPRESENTATIVE_DATASET_NAME);
    expect(representative.env.REPRESENTATIVE_DATASET_REVISION).toBe(REPRESENTATIVE_DATASET_REVISION);
    const tasks = (await readFile(path.join(workspace, representative.env.REPRESENTATIVE_DATASET!), "utf8"))
      .trim().split("\n").map(line => JSON.parse(line));
    const matrix = JSON.parse(await readFile(path.join(workspace, "evaluations/representative-assembly-matrix.json"), "utf8"));
    expect([...new Set(matrix.expectedCases.map((row: { scenarioId: string }) => row.scenarioId))].sort())
      .toEqual(tasks.map(task => task.task_id).sort());
    const assembly = representative.steps.find(step => step.id === "representative_assembly")!;
    expect(assembly.run).toContain("scripts/assemble-representative-evidence.ts");
    const enforce = representative.steps.find(step => step.run?.includes("--diagnostics-dir release-artifacts/representative-diagnostics"))!;
    expect(enforce.if).toBe("${{ always() }}");
    for (const [provider, model] of Object.entries(await candidateModels())) {
      const id = `representative_${provider}`;
      const evaluation = representative.steps.find(step => step.id === id)!;
      expect(evaluation).toBeDefined();
      expect(evaluation.if).toBeUndefined();
      expect(evaluation.run).toMatch(new RegExp(`--tasks\\s+${tasks.length}\\b`));
      expect(evaluation.run).toContain("--profiles governed --carriers rule_file");
      expect(evaluation.run).toContain(`--provider ${provider} --model ${model}`);
      expect(evaluation.run).toContain(`--diagnostics-out release-artifacts/representative-diagnostics/${provider}.json`);
      expect(assembly.if).toContain(`steps.${id}.outcome == 'success'`);
      expect(enforce.run).toContain(`--gate "${provider}=\${{ steps.${id}.outcome }}"`);
    }
    const uploads = representative.steps.filter(step => step.uses?.startsWith("actions/upload-artifact@"));
    expect(uploads.some(step => step.with?.path === "release-artifacts/representative-evidence-*.json")).toBe(true);
    expect(uploads.some(step => step.with?.path === "release-artifacts/representative-diagnostics/*.json" && step.if === "${{ always() }}")).toBe(true);
    expect(uploads.some(step => String(step.with?.path).includes("representative-raw"))).toBe(false);
  });

  for (const workflowPath of workflowPaths) {
    test(`${workflowPath} enforces the aggregate result with the intended gate continuation policy`, async () => {
      const workflow = await readFile(path.join(workspace, workflowPath), "utf8");

      for (const gate of [
        "live_oci_preload",
        "live_oci",
        "live_base",
        "live_orchestration",
        "live_compaction", "live_continuity", "live_routing_vertex", "live_routing_anthropic", "live_routing_gemini", "live_routing_meta",
        "live_execution"
      ]) {
        const diagnosticGate = gate.replace("live_", "").replaceAll("_", "-");
        expect(workflow).toContain(`id: ${gate}`);
        expect(workflow).toContain(`--gate "${diagnosticGate}=\${{ steps.${gate}.outcome }}"`);
        const block = workflow.match(new RegExp(
          `id: ${gate}\\n([\\s\\S]*?)(?=\\n      - name:)`
        ))?.[0];
        if (workflowPath.endsWith("/release.yml")) {
          expect(block).not.toContain("continue-on-error:");
        } else {
          expect(block).toContain("continue-on-error: true");
        }
        expect(block).toContain("bun run scripts/run-release-gate.ts");
        expect(block).toContain(`--gate ${diagnosticGate}`);
        expect(block).toContain(
          `--out release-artifacts/live-diagnostics/${diagnosticGate}.json`
        );
      }
      expect(workflow).toContain("name: Enforce complete live certification result");
      expect(workflow).toContain("if: ${{ always() }}");
      expect(workflow).toContain("scripts/release-diagnostics.ts");
      expect(workflow).toContain("--diagnostics-dir release-artifacts/live-diagnostics");
      expect(workflow).toContain("WORKFLOW_RUN_ATTEMPT: ${{ github.run_attempt }}");
      expect(workflow).toContain('echo "ARTIFACT_SHA512=$ARTIFACT_SHA512" >> "$GITHUB_ENV"');
      expect(workflow).toContain('echo "SOURCE_COMMIT=$(git rev-parse HEAD)" >> "$GITHUB_ENV"');
      expect(workflow).toContain("name: Upload sanitized live diagnostics");
      expect(workflow).toContain("name: live-diagnostics-${{ github.sha }}-${{ github.run_attempt }}");
      expect(workflow).toContain("release-artifacts/live-diagnostics/*.json");
    });
  }

  test("release-bound live diagnostics use the validated tarball while manual certification packs the tag", async () => {
    const release = await readFile(path.join(workspace, ".github/workflows/release.yml"), "utf8");
    const manual = await readFile(path.join(workspace, ".github/workflows/live-certification.yml"), "utf8");

    const releaseLive = release.slice(release.indexOf("  certify-live:"), release.indexOf("  representative-evaluation:"));
    const manualBinding = manual.slice(
      manual.indexOf("      - name: Bind immutable live diagnostic identity"),
      manual.indexOf("      - name: Validate protected provider configuration")
    );
    expect(releaseLive).toContain("name: Download immutable validated artifact");
    expect(releaseLive).toContain("shasum -a 512 -c SHA512SUMS");
    expect(manualBinding).toContain("bun run build");
    expect(manualBinding).toContain('bun pm pack --filename "$ARTIFACT" --ignore-scripts');
    expect(manualBinding).toContain('bun run artifact:check -- "$ARTIFACT"');
    expect(manualBinding.indexOf("bun run build"))
      .toBeLessThan(manualBinding.indexOf('bun pm pack --filename "$ARTIFACT" --ignore-scripts'));
    expect(manualBinding.indexOf('bun pm pack --filename "$ARTIFACT" --ignore-scripts'))
      .toBeLessThan(manualBinding.indexOf('bun run artifact:check -- "$ARTIFACT"'));
  });

  test("representative evaluation loads the exact unpacked artifact runtime", async () => {
    const workflow = await readFile(path.join(workspace, ".github/workflows/release.yml"), "utf8");

    expect(workflow).toContain('tar -xzf "$ARTIFACT" -C "$RUNTIME_ROOT"');
    expect(workflow).toContain('RUNTIME_MODULE="$RUNTIME_ROOT/package/dist/index.js"');
    expect(workflow).toContain('test "$RUNTIME_VERSION" = "${RELEASE_TAG#v}"');
    expect(workflow).toContain('echo "ZHIVEX_SAFE_FIX_HARNESS_RUNTIME=$RUNTIME_MODULE" >> "$GITHUB_ENV"');
    expect(workflow).toContain("scripts/time-to-safe-fix-runtime.ts");
  });

  test("executes the workflow SHA-512 expression against its first Bun argument", async () => {
    const workflow = await readFile(path.join(workspace, ".github/workflows/release.yml"), "utf8");
    const expression = workflow.match(/ARTIFACT_SHA512="\$\(bun -e '([^']+)' "\$ARTIFACT"\)"/)?.[1];
    expect(expression).toContain("process.argv[1]");
    expect(expression).not.toContain("process.argv[2]");

    const directory = await mkdtemp(path.join(os.tmpdir(), "zhivex-release-integrity-"));
    try {
      const artifact = path.join(directory, "artifact.tgz");
      const bytes = Buffer.from("exact release artifact fixture\n");
      await writeFile(artifact, bytes);
      const child = Bun.spawn(["bun", "-e", expression!, artifact], {
        stdin: "ignore",
        stdout: "pipe",
        stderr: "pipe"
      });
      const [stdout, stderr, exitCode] = await Promise.all([
        new Response(child.stdout).text(),
        new Response(child.stderr).text(),
        child.exited
      ]);
      expect(exitCode, stderr).toBe(0);
      expect(stdout).toBe(`sha512-${createHash("sha512").update(bytes).digest("base64")}`);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});

test("release preflight precedes Docker and full validation; transfer supports recovery", async () => {
  const workflow = Bun.YAML.parse(await readFile(path.join(workspace, ".github/workflows/release.yml"), "utf8")) as {
    jobs: Record<string, { needs?: string[]; if?: string; steps: { run?: string; with?: Record<string, unknown> }[] }>;
  };
  const steps = workflow.jobs.validate!.steps;
  const preflight = steps.findIndex(step => step.run?.includes("--registry"));
  expect(preflight).toBeGreaterThanOrEqual(0);
  expect(preflight).toBeLessThan(steps.findIndex(step => step.run?.includes("docker pull")));
  expect(preflight).toBeLessThan(steps.findIndex(step => step.run?.includes("bun run release:check")));
  expect(steps.find(step => step.with?.name === "npm-release-${{ github.sha }}")?.with?.["retention-days"]).toBe(30);
  expect(workflow.jobs.summary!.needs).toEqual(["validate", "certify-live", "representative-evaluation", "publish"]);
  expect(workflow.jobs.summary!.if).toBe("${{ always() }}");
  expect(workflow.jobs.publish!.needs).not.toContain("summary");
});

test("registry summary distinguishes verification, accepted bytes and uncertain transaction failures", async () => {
  const workflow = Bun.YAML.parse(await readFile(path.join(workspace, ".github/workflows/release.yml"), "utf8")) as {
    jobs: Record<string, { steps: { name?: string; run?: string }[] }>;
  };
  const script = workflow.jobs.publish!.steps.find(step => step.name === "Summarize registry transaction")!.run!;
  const directory = await mkdtemp(path.join(os.tmpdir(), "release-summary-"));
  try {
    for (const [registry, publication, verification, expected] of [
      ["absent", "success", "success", "Published and verified"],
      ["absent", "success", "failure", "verification pending"],
      ["identical", "skipped", "failure", "verification pending"],
      ["absent", "failure", "skipped", "acceptance unknown"],
      ["absent", "cancelled", "skipped", "acceptance unknown"],
      ["", "skipped", "skipped", "not attempted"]
    ]) {
      const summary = path.join(directory, "summary.md");
      await writeFile(summary, "");
      const child = Bun.spawn(["bash", "-eu", "-c", script], { env: {
        ...process.env, GITHUB_STEP_SUMMARY: summary, REGISTRY_STATE: registry!, PUBLICATION: publication!, VERIFICATION: verification!
      }, stdout: "pipe", stderr: "pipe" });
      expect(await child.exited).toBe(0);
      expect(await readFile(summary, "utf8")).toContain(expected!);
    }
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test("standalone and release live gates certify the declared candidate cohort", async () => {
  const release = await readWorkflow("release.yml");
  const standalone = await readWorkflow("live-certification.yml");
  for (const [provider, model] of Object.entries(await candidateModels())) {
    const key = `ZHIVEX_HARNESS_LIVE_${provider.toUpperCase()}_MODEL`;
    for (const job of [release.jobs["certify-live"]!, standalone.jobs.certify!]) {
      expect(job.env[key]).toBe(model);
      for (const step of job.steps) expect(step.env?.[key]).toBeUndefined();
    }
  }
});

test("all live release gates select the checked artifact and prohibit source fallback", async () => {
  for (const file of workflowPaths) {
    const workflow = await readFile(path.join(workspace, file), "utf8");
    const binding = workflow.slice(workflow.indexOf("      - name: Bind immutable live diagnostic identity"),
      workflow.indexOf("      - name: Preload", workflow.indexOf("      - name: Bind immutable live diagnostic identity")));
    expect(binding).toContain('tar -xzf "$ARTIFACT" -C "$LIVE_RUNTIME_ROOT"');
    expect(binding).toContain('ZHIVEX_HARNESS_LIVE_RUNTIME=$LIVE_RUNTIME_ROOT/package/dist/index.js');
    expect(binding).toContain('ZHIVEX_HARNESS_LIVE_REQUIRE_ARTIFACT=1');
    expect(binding.indexOf("artifact:check")).toBeLessThan(binding.indexOf("tar -xzf"));
  }
  for (const name of ["provider", "orchestration", "routing", "execution"]) {
    const source = await readFile(path.join(workspace, `scripts/live-${name}-smoke.ts`), "utf8");
    expect(source).toMatch(/await loadLiveSmokeRuntime\((?:env)?\)/);
    if (name === "routing") {
      expect(source).toContain("= loadDependencies");
      expect(source).toContain("runLiveRoutingSmoke(process.env)");
    }
    expect(source).not.toContain('from "../src/runtime/harness.js"');
  }
});

test("Desktop CI exercises packaged restart, uncertain effects and worktree delivery", async () => {
  const workflow = Bun.YAML.parse(await readFile(path.join(workspace, ".github/workflows/ci.yml"), "utf8")) as {
    jobs: Record<string, { steps: { run?: string }[] }>;
  };
  const steps = workflow.jobs["desktop-security"]!.steps;
  const packaged = steps.find(step => step.run?.includes("bun run --cwd desktop package"))!.run!;
  // Restart/history checks invoke the root CLI; Desktop packaging does not build it.
  const commands = steps.flatMap(step => (step.run ?? "").split("\n").map(line => line.trim()));
  const cliBuild = commands.indexOf("bun run prepare:desktop");
  const manifest = await Bun.file(new URL("../package.json", import.meta.url)).json();
  expect(manifest.scripts["prepare:desktop"]).toStartWith("bun run build && bun pm pack");
  expect(manifest.scripts["prepare:desktop"]).toContain("desktop/scripts/prepare-harness.ts");
  expect(cliBuild).toBeGreaterThanOrEqual(0);
  expect(cliBuild).toBeLessThan(commands.indexOf("bun run --cwd desktop smoke:restart:packaged"));
  for (const scenario of ["smoke:restart:packaged", "smoke:restart:packaged --effect-crash", "smoke:restart:packaged --active-close", "smoke:worktrees:packaged"]) {
    expect(packaged).toContain(`bun run --cwd desktop ${scenario}`);
  }
});
