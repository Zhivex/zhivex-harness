import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { expect, test } from "bun:test";

const root = path.resolve(import.meta.dir, "..");
const workflowDir = path.join(root, ".github", "workflows");

type Job = {
  needs?: string | string[];
  if?: string;
  permissions?: Record<string, string>;
  environment?: string;
  uses?: string;
  with?: Record<string, string>;
  steps?: { name?: string; run?: string; env?: Record<string, string>; uses?: string; with?: Record<string, unknown> }[];
};

const readWorkflow = async (name: string) =>
  Bun.YAML.parse(await readFile(path.join(workflowDir, name), "utf8")) as {
    permissions?: Record<string, string>;
    jobs: Record<string, Job>;
    on?: { workflow_call?: { outputs?: Record<string, { value?: string }> } };
  };

const needsOf = (job: Job) => job.needs === undefined ? [] : Array.isArray(job.needs) ? job.needs : [job.needs];

const git = async (args: string[], cwd?: string) => {
  const child = Bun.spawn(["git", ...args], {
    stdout: "pipe", stderr: "pipe", stdin: "ignore",
    env: {
      PATH: process.env.PATH ?? "",
      HOME: process.env.HOME ?? "",
      GIT_AUTHOR_NAME: "Release",
      GIT_AUTHOR_EMAIL: "release@example.com",
      GIT_COMMITTER_NAME: "Release",
      GIT_COMMITTER_EMAIL: "release@example.com"
    },
    ...(cwd === undefined ? {} : { cwd })
  });
  const [stdout, stderr, code] = await Promise.all([
    new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited
  ]);
  expect(code, `${args.join(" ")}\n${stderr}`).toBe(0);
  return stdout.trim();
};

const resolverScript = async () => {
  const workflow = await readWorkflow("resolve-protected-release-ref.yml");
  const script = workflow.jobs.resolve?.steps?.find(step => step.run?.includes("merge-base --is-ancestor"))?.run;
  expect(script).toBeDefined();
  expect(script).toContain('remote="https://github.com/${GITHUB_REPOSITORY}.git"');
  expect(script).not.toContain("RELEASE_REF_REMOTE");
  expect(script).not.toContain("secrets.");
  return script!;
};

test("protected release workflows bind the tag before secrets and id-token", async () => {
  const resolver = await readWorkflow("resolve-protected-release-ref.yml");
  expect(resolver.permissions).toEqual({});
  expect(resolver.jobs.resolve?.permissions).toEqual({});
  expect(resolver.jobs.resolve?.environment).toBeUndefined();
  expect(resolver.on?.workflow_call?.outputs?.sha?.value).toBe("${{ jobs.resolve.outputs.sha }}");
  expect(JSON.stringify(resolver)).not.toContain("secrets.");
  expect(JSON.stringify(resolver)).not.toContain("id-token");

  for (const [file, kind] of [
    ["release.yml", "harness"],
    ["release-code.yml", "code"],
    ["live-certification.yml", "harness"]
  ] as const) {
    const workflow = await readWorkflow(file);
    const source = await readFile(path.join(workflowDir, file), "utf8");
    expect(source).not.toContain("ref: ${{ inputs.tag }}");
    const resolve = workflow.jobs["resolve-release-commit"];
    expect(resolve?.permissions).toEqual({});
    expect(resolve?.uses).toBe("./.github/workflows/resolve-protected-release-ref.yml");
    expect(resolve?.with).toEqual({ tag: "${{ inputs.tag }}", kind });
    expect(resolve?.environment).toBeUndefined();
    expect(needsOf(resolve!)).toEqual([]);

    for (const [name, job] of Object.entries(workflow.jobs)) {
      const needs = needsOf(job);
      const privileged = job.permissions?.["id-token"] === "write" ||
        JSON.stringify(job).includes("${{ secrets.");
      if (privileged) {
        expect(needs, `${file} ${name}`).toContain("resolve-release-commit");
        expect(job.if, `${file} ${name}`).toContain("needs.resolve-release-commit.result == 'success'");
      }
      for (const step of job.steps ?? []) {
        if (step.uses?.startsWith("actions/checkout@")) {
          expect(step.with?.ref, `${file} ${name}`).toBe("${{ needs.resolve-release-commit.outputs.sha }}");
          expect(step.with?.["persist-credentials"]).toBe(false);
          expect(step.with?.["fetch-depth"]).toBe(0);
          expect(step.with?.["fetch-tags"]).toBe(true);
          expect(needs, `${file} ${name}`).toContain("resolve-release-commit");
        }
      }
    }
  }

  const release = await readWorkflow("release.yml");
  const code = await readWorkflow("release-code.yml");
  const live = await readWorkflow("live-certification.yml");
  expect(live.permissions?.["id-token"]).toBeUndefined();
  expect(live.jobs.certify?.permissions?.["id-token"]).toBe("write");
  expect(release.jobs.publish?.permissions?.["id-token"]).toBe("write");
  expect(release.jobs["certify-live"]?.permissions?.["id-token"]).toBe("write");
  expect(release.jobs.validate?.permissions?.["id-token"]).toBeUndefined();
  expect(code.jobs.validate?.permissions?.["id-token"]).toBe("write");
  expect(code.jobs.publish?.permissions?.["id-token"]).toBe("write");
  expect(release.jobs.publish?.steps?.some(step => step.run?.includes('npm publish "./$ARTIFACT" --access public --provenance --tag "$RELEASE_CHANNEL"'))).toBe(true);
  expect(release.jobs.publish?.steps?.some(step => step.run?.includes('bun run release:verify -- "$ARTIFACT" "$RELEASE_CHANNEL"'))).toBe(true);
  expect(code.jobs.validate?.steps?.some(step => step.run?.includes("code-bootstrap-provenance.cjs generate"))).toBe(true);
  expect(code.jobs.publish?.steps?.some(step => step.run?.includes("--provenance"))).toBe(true);
  expect(code.jobs.publish?.steps?.some(step => step.run?.includes("code-release.ts verify"))).toBe(true);

  const ci = await readFile(path.join(workflowDir, "ci.yml"), "utf8");
  expect(ci).toContain("actionlint");
  expect(ci).toContain("shellcheck");
  expect(ci).toContain("8aca8db96f1b94770f1b0d72b6dddcb1ebb8123cb3712530b08cc387b349a3d8");
});

test("annotated tag resolution accepts only the workflow commit on main", async () => {
  const script = await resolverScript();
  const directory = await mkdtemp(path.join(os.tmpdir(), "zhivex-release-ref-"));
  try {
    const remote = path.join(directory, "origin.git");
    const work = path.join(directory, "work");
    await git(["init", "--bare", "--initial-branch=main", remote]);
    await git(["init", "--initial-branch=main", work]);
    await git(["commit", "--allow-empty", "-m", "main"], work);
    const mainSha = await git(["rev-parse", "HEAD"], work);
    await git(["tag", "-a", "v1.2.3", "-m", "Harness"], work);
    await git(["tag", "-a", "v1.2.3-rc.2", "-m", "Harness RC"], work);
    await git(["tag", "v1.2.4"], work);
    await git(["tag", "-a", "code-v0.1.0", "-m", "Code"], work);
    await git(["checkout", "--orphan", "side"], work);
    await git(["commit", "--allow-empty", "-m", "side"], work);
    const sideSha = await git(["rev-parse", "HEAD"], work);
    await git(["tag", "-a", "v9.9.9", "-m", "off main"], work);
    await git(["tag", "-a", "code-v0.9.9", "-m", "code off main"], work);
    await git(["remote", "add", "origin", remote], work);
    await git(["push", "origin", "main"], work);
    await git(["push", "origin", "refs/tags/v1.2.3", "refs/tags/v1.2.3-rc.2", "refs/tags/v1.2.4", "refs/tags/code-v0.1.0", "refs/tags/v9.9.9", "refs/tags/code-v0.9.9"], work);

    const localized = script.replace(
      'remote="https://github.com/${GITHUB_REPOSITORY}.git"',
      `remote=${JSON.stringify(remote)}`
    );
    const output = path.join(directory, "github-output");
    const run = async (env: Record<string, string>) => {
      await Bun.write(output, "");
      const child = Bun.spawn(["bash", "-eu", "-c", localized], {
        env: {
          PATH: process.env.PATH ?? "",
          HOME: process.env.HOME ?? "",
          GITHUB_OUTPUT: output,
          GITHUB_REPOSITORY: "Zhivex/zhivex-harness",
          ...env
        },
        stdout: "pipe", stderr: "pipe", stdin: "ignore"
      });
      const [stdout, stderr, code] = await Promise.all([
        new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited
      ]);
      return { code, stdout, stderr, output: await readFile(output, "utf8") };
    };

    const harness = await run({ TAG_KIND: "harness", RELEASE_TAG: "v1.2.3", GITHUB_SHA: mainSha, GITHUB_REF: "refs/heads/main" });
    expect(harness.code, harness.stderr).toBe(0);
    expect(harness.output).toBe(`sha=${mainSha}\n`);
    const candidate = await run({ TAG_KIND: "harness", RELEASE_TAG: "v1.2.3-rc.2", GITHUB_SHA: mainSha, GITHUB_REF: "refs/tags/v1.2.3-rc.2" });
    expect(candidate.code, candidate.stderr).toBe(0);
    const code = await run({ TAG_KIND: "code", RELEASE_TAG: "code-v0.1.0", GITHUB_SHA: mainSha, GITHUB_REF: "refs/tags/code-v0.1.0" });
    expect(code.code, code.stderr).toBe(0);
    expect(code.output).toBe(`sha=${mainSha}\n`);

    const rejected = [
      [{ TAG_KIND: "harness", RELEASE_TAG: "main", GITHUB_SHA: mainSha, GITHUB_REF: "refs/heads/main" }, "annotated tag pattern"],
      [{ TAG_KIND: "harness", RELEASE_TAG: "v1.2.3;touch /tmp/pwn", GITHUB_SHA: mainSha, GITHUB_REF: "refs/tags/v1.2.3" }, "annotated tag pattern"],
      [{ TAG_KIND: "harness", RELEASE_TAG: "v1.2.4", GITHUB_SHA: mainSha, GITHUB_REF: "refs/tags/v1.2.4" }, "annotated tag object"],
      [{ TAG_KIND: "harness", RELEASE_TAG: "v1.2.3", GITHUB_SHA: sideSha, GITHUB_REF: "refs/tags/v1.2.3" }, "protected workflow commit"],
      [{ TAG_KIND: "harness", RELEASE_TAG: "v9.9.9", GITHUB_SHA: sideSha, GITHUB_REF: "refs/tags/v9.9.9" }, "not reachable from main"],
      [{ TAG_KIND: "code", RELEASE_TAG: "code-v0.1.0", GITHUB_SHA: mainSha, GITHUB_REF: "refs/heads/main" }, "annotated tag"],
      [{ TAG_KIND: "code", RELEASE_TAG: "code-v0.9.9", GITHUB_SHA: sideSha, GITHUB_REF: "refs/tags/code-v0.9.9" }, "not reachable from main"],
      [{ TAG_KIND: "branch", RELEASE_TAG: "v1.2.3", GITHUB_SHA: mainSha, GITHUB_REF: "refs/tags/v1.2.3" }, "unsupported release tag kind"],
      [{ TAG_KIND: "harness", RELEASE_TAG: "v1.2.3", GITHUB_SHA: mainSha, GITHUB_REF: "refs/tags/v1.2.3", GITHUB_REPOSITORY: "fork/zhivex-harness" }, "Zhivex/zhivex-harness"]
    ] as const;
    for (const [env, message] of rejected) {
      const result = await run({ ...env });
      expect(result.code, `${env.RELEASE_TAG} ${result.stderr}`).not.toBe(0);
      expect(result.stderr).toContain(message);
      expect(result.output).toBe("");
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
