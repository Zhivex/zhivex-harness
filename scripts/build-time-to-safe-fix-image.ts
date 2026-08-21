import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";

const root = path.resolve(import.meta.dir, "..");
const dockerfilePath = path.join(root, "docker", "time-to-safe-fix.Dockerfile");
const requirementsPath = path.join(root, "docker", "time-to-safe-fix.requirements.txt");
const baseDigest = "sha256:3638d9a6fe4030bd716be989438248074489337ba3275657f93595428be4fc03";
const baseReference = `node:24-bookworm-slim@${baseDigest}`;
const defaultTag = "zhivex-harness/time-to-safe-fix:node24-pytest9";
const MAX_CAPTURE_BYTES = 1_000_000;

interface Options {
  tag: string;
  expectedImageId?: string;
  validateOnly: boolean;
}

const valueAfter = (args: readonly string[], index: number, name: string) => {
  const value = args[index + 1];
  if (!value || value.startsWith("--")) throw new Error(`${name} requires a value.`);
  return value;
};

const parseOptions = (args: readonly string[]): Options => {
  let tag = defaultTag;
  let expectedImageId = process.env.ZHIVEX_SAFE_FIX_EXPECTED_IMAGE_ID;
  let validateOnly = false;
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--tag") tag = valueAfter(args, index++, arg);
    else if (arg === "--expected-image-id") expectedImageId = valueAfter(args, index++, arg);
    else if (arg === "--validate-only") validateOnly = true;
    else throw new Error(`Unknown option: ${arg}`);
  }
  if (!/^[a-zA-Z0-9][a-zA-Z0-9._/-]*(?::[a-zA-Z0-9][a-zA-Z0-9._-]*)?$/.test(tag)) {
    throw new Error("--tag must be a bounded local OCI image reference.");
  }
  if (expectedImageId && !/^sha256:[a-f0-9]{64}$/.test(expectedImageId)) {
    throw new Error("--expected-image-id must be a sha256 image ID.");
  }
  return { tag, ...(expectedImageId ? { expectedImageId } : {}), validateOnly };
};

const run = async (
  command: string,
  args: readonly string[],
  options: { capture?: boolean } = {}
) => new Promise<string>((resolve, reject) => {
  const child = spawn(command, [...args], {
    cwd: root,
    env: process.env,
    stdio: options.capture ? ["ignore", "pipe", "pipe"] : "inherit",
    shell: false
  });
  const chunks: Buffer[] = [];
  let bytes = 0;
  const collect = (chunk: Buffer) => {
    bytes += chunk.byteLength;
    if (bytes > MAX_CAPTURE_BYTES) {
      child.kill("SIGKILL");
      return;
    }
    chunks.push(chunk);
  };
  if (options.capture) {
    child.stdout?.on("data", collect);
    child.stderr?.on("data", collect);
  }
  child.once("error", reject);
  child.once("close", (code, signal) => {
    const output = Buffer.concat(chunks).toString("utf8").trim();
    if (bytes > MAX_CAPTURE_BYTES) {
      reject(new Error(`${command} output exceeded ${MAX_CAPTURE_BYTES} bytes.`));
    } else if (code !== 0) {
      reject(new Error(`${command} ${args[0] ?? ""} failed${signal ? ` with ${signal}` : ` with exit ${code}`}: ${output}`));
    } else {
      resolve(output);
    }
  });
});

const options = parseOptions(process.argv.slice(2));
const [dockerfile, requirements] = await Promise.all([
  readFile(dockerfilePath, "utf8"),
  readFile(requirementsPath, "utf8")
]);

if (!dockerfile.includes(`FROM ${baseReference}`)) {
  throw new Error(`Benchmark Dockerfile must use the pinned base ${baseReference}.`);
}
if (!dockerfile.includes("20260821T000000Z")) {
  throw new Error("Benchmark Dockerfile must use the reviewed Debian snapshot timestamp.");
}
if (!dockerfile.includes("--require-hashes") || !dockerfile.includes("--only-binary=:all:")) {
  throw new Error("Benchmark Dockerfile must require hashes and binary Python distributions.");
}

const requirementLines = requirements.split(/\r?\n/)
  .map((line) => line.trim())
  .filter((line) => line && !line.startsWith("#"));
const expectedPackages = ["iniconfig", "packaging", "pluggy", "pygments", "pytest"];
if (requirementLines.length !== expectedPackages.length) {
  throw new Error(`Expected ${expectedPackages.length} locked Python packages, received ${requirementLines.length}.`);
}
for (const expectedPackage of expectedPackages) {
  const line = requirementLines.find((candidate) => candidate.toLocaleLowerCase().startsWith(`${expectedPackage}==`));
  if (!line || !/^[A-Za-z0-9_.-]+==[^\s]+ --hash=sha256:[a-f0-9]{64}$/.test(line)) {
    throw new Error(`Missing exact version and sha256 wheel hash for ${expectedPackage}.`);
  }
}

const inputSha256 = createHash("sha256")
  .update(dockerfile)
  .update("\0")
  .update(requirements)
  .digest("hex");
const lockedInput = {
  schemaVersion: 1,
  kind: "time-to-safe-fix-image-input",
  dockerfile: path.relative(root, dockerfilePath),
  requirements: path.relative(root, requirementsPath),
  baseReference,
  debianSnapshot: "20260821T000000Z",
  pythonPackages: Object.fromEntries(requirementLines.map((line) => {
    const [requirement] = line.split(" ", 1);
    const separator = requirement!.indexOf("==");
    return [requirement!.slice(0, separator).toLocaleLowerCase(), requirement!.slice(separator + 2)];
  })),
  inputSha256
};

if (options.validateOnly) {
  process.stdout.write(`${JSON.stringify({ ...lockedInput, validated: true }, null, 2)}\n`);
  process.exit(0);
}

await run("docker", [
  "build",
  "--pull=false",
  "--provenance=false",
  "--file", dockerfilePath,
  "--tag", options.tag,
  "--label", `ai.zhivex.benchmark.input-sha256=${inputSha256}`,
  root
]);

const inspection = JSON.parse(await run("docker", [
  "image", "inspect", options.tag, "--format", "{{json .}}"
], { capture: true })) as {
  Id?: string;
  Config?: { Labels?: Record<string, string> };
};
const imageId = inspection.Id;
if (!imageId || !/^sha256:[a-f0-9]{64}$/.test(imageId)) {
  throw new Error("Docker did not return a content-addressed sha256 image ID.");
}
if (options.expectedImageId && options.expectedImageId !== imageId) {
  throw new Error(`Built image ID ${imageId} does not match expected ${options.expectedImageId}.`);
}
if (inspection.Config?.Labels?.["org.opencontainers.image.base.digest"] !== baseDigest) {
  throw new Error("Built image does not retain the expected base-image digest label.");
}
if (inspection.Config?.Labels?.["ai.zhivex.benchmark.input-sha256"] !== inputSha256) {
  throw new Error("Built image does not retain the benchmark input digest label.");
}

const [nodeVersion, pythonVersion, pytestVersion] = await Promise.all([
  run("docker", ["run", "--rm", "--network", "none", "--entrypoint", "node", imageId, "--version"], { capture: true }),
  run("docker", ["run", "--rm", "--network", "none", "--entrypoint", "python3", imageId, "--version"], { capture: true }),
  run("docker", ["run", "--rm", "--network", "none", "--entrypoint", "pytest", imageId, "--version"], { capture: true })
]);
if (!/^v24\./.test(nodeVersion)) throw new Error(`Expected Node 24, received ${nodeVersion}.`);
if (!/^Python 3\.11\./.test(pythonVersion)) throw new Error(`Expected Python 3.11, received ${pythonVersion}.`);
if (!/^pytest 9\.0\.3\b/.test(pytestVersion)) throw new Error(`Expected pytest 9.0.3, received ${pytestVersion}.`);

process.stdout.write(`${JSON.stringify({
  ...lockedInput,
  kind: "time-to-safe-fix-image-build",
  tag: options.tag,
  imageId,
  expectedImageId: options.expectedImageId ?? null,
  verified: { nodeVersion, pythonVersion, pytestVersion, networkDuringVerification: "none" }
}, null, 2)}\n`);
