import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { describe, expect, test } from "bun:test";

const workspace = path.resolve(import.meta.dir, "..");
const workflowPaths = [
  ".github/workflows/release.yml",
  ".github/workflows/live-certification.yml"
] as const;

describe("release workflow version source", () => {
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

  test("publication requires complete sanitized representative evidence", async () => {
    const workflow = await readFile(path.join(workspace, ".github/workflows/release.yml"), "utf8");

    expect(workflow).toContain("representative-evaluation:");
    expect(workflow).toContain("- representative-evaluation");
    expect(workflow).toContain("needs.representative-evaluation.result == 'success'");
    expect(workflow).toContain("evaluations/representative-repositories.jsonl");
    expect(workflow).toContain("--tasks 7 --repetitions 1 --profiles governed --carriers rule_file");
    expect(workflow).toContain("--provider meta --model muse-spark-1.2");
    expect(workflow).toContain("--provider qwen --model qwen3.8-max");
    expect(workflow).toContain("--provider openai --model gpt-5.6-luna");
    expect(workflow).toContain("scripts/assemble-representative-evidence.ts");
    expect(workflow).toContain("path: release-artifacts/representative-evidence-*.json");
    expect(workflow).toContain("--diagnostics-out release-artifacts/representative-diagnostics/");
    expect(workflow).toContain("name: representative-diagnostics-${{ github.sha }}-${{ github.run_attempt }}");
    expect(workflow).toContain("path: release-artifacts/representative-diagnostics/*.json");
    expect(workflow).toContain("if: ${{ always() }}");
    expect(workflow).toContain("WORKFLOW_RUN_ATTEMPT: ${{ github.run_attempt }}");
    expect(workflow).toContain("id: representative_meta");
    expect(workflow).toContain("id: representative_qwen");
    expect(workflow).toContain("id: representative_openai");
    expect(workflow).toContain("steps.representative_meta.outcome == 'success'");
    expect(workflow).toContain("steps.representative_qwen.outcome == 'success'");
    expect(workflow).toContain("steps.representative_openai.outcome == 'success'");
    expect(workflow).toContain("scripts/release-diagnostics.ts");
    expect(workflow).toContain("--diagnostics-dir release-artifacts/representative-diagnostics");
    expect(workflow).toContain('--gate "meta=${{ steps.representative_meta.outcome }}"');
    expect(workflow).toContain('--gate "qwen=${{ steps.representative_qwen.outcome }}"');
    expect(workflow).toContain('--gate "openai=${{ steps.representative_openai.outcome }}"');
    expect(workflow).not.toContain("path: release-artifacts/representative-raw");
  });

  for (const workflowPath of workflowPaths) {
    test(`${workflowPath} completes every live gate before enforcing the aggregate result`, async () => {
      const workflow = await readFile(path.join(workspace, workflowPath), "utf8");

      for (const gate of [
        "live_oci_preload",
        "live_oci",
        "live_base",
        "live_orchestration",
        "live_routing",
        "live_execution"
      ]) {
        const diagnosticGate = gate.replace("live_", "").replaceAll("_", "-");
        expect(workflow).toContain(`id: ${gate}`);
        expect(workflow).toContain(`--gate "${diagnosticGate}=\${{ steps.${gate}.outcome }}"`);
        const block = workflow.match(new RegExp(
          `id: ${gate}\\n([\\s\\S]*?)(?=\\n      - name:)`
        ))?.[0];
        expect(block).toContain("continue-on-error: true");
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
      expect(workflow).toContain("path: release-artifacts/live-diagnostics/*.json");
    });
  }

  test("release-bound live diagnostics use the validated tarball while manual certification packs the tag", async () => {
    const release = await readFile(path.join(workspace, ".github/workflows/release.yml"), "utf8");
    const manual = await readFile(path.join(workspace, ".github/workflows/live-certification.yml"), "utf8");

    const releaseLive = release.slice(release.indexOf("  certify-live:"), release.indexOf("  representative-evaluation:"));
    const manualBinding = manual.slice(
      manual.indexOf("      - name: Bind immutable live diagnostic identity"),
      manual.indexOf("      - name: Preload OCI execution image")
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
