import { lstat } from "node:fs/promises";
import path from "node:path";

export const HARNESS_PACKAGE_MANAGERS = ["npm", "pnpm", "yarn", "bun"] as const;

export type HarnessPackageManager = (typeof HARNESS_PACKAGE_MANAGERS)[number];

export interface PackageManagerResolution {
  manager: HarnessPackageManager;
  source: "packageManager" | "lockfile" | "default";
  evidence?: string;
}

export interface PackageCheckCommand extends PackageManagerResolution {
  command: [string, ...string[]];
}

interface PackageManifestLike {
  packageManager?: unknown;
  scripts?: unknown;
}

const LOCKFILES: Readonly<Record<HarnessPackageManager, readonly string[]>> = {
  npm: ["package-lock.json", "npm-shrinkwrap.json"],
  pnpm: ["pnpm-lock.yaml"],
  yarn: ["yarn.lock"],
  bun: ["bun.lock", "bun.lockb"]
};

const isPackageManager = (value: string): value is HarnessPackageManager =>
  (HARNESS_PACKAGE_MANAGERS as readonly string[]).includes(value);

const parsePackageManager = (value: unknown): HarnessPackageManager | undefined => {
  if (value === undefined) return undefined;
  if (typeof value !== "string") {
    throw new Error("package.json packageManager must be a string when present.");
  }
  const match = /^(npm|pnpm|yarn|bun)@([^\s]+)$/.exec(value.trim());
  if (!match?.[1] || !match[2]) {
    throw new Error(
      "package.json packageManager must pin npm, pnpm, yarn, or bun using <manager>@<version>."
    );
  }
  if (!isPackageManager(match[1])) {
    throw new Error(`Unsupported package manager: ${match[1]}.`);
  }
  return match[1];
};

const existingLockfiles = async (root: string) => {
  const matches: Array<{ manager: HarnessPackageManager; file: string }> = [];
  for (const manager of HARNESS_PACKAGE_MANAGERS) {
    for (const file of LOCKFILES[manager]) {
      try {
        const entry = await lstat(path.join(root, file));
        if (entry.isSymbolicLink()) {
          throw new Error(`Package-manager lockfile must not be a symbolic link: ${file}.`);
        }
        if (entry.isFile()) matches.push({ manager, file });
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
    }
  }
  return matches;
};

export const resolvePackageManager = async (
  root: string,
  manifest: PackageManifestLike
): Promise<PackageManagerResolution> => {
  const declared = parsePackageManager(manifest.packageManager);
  if (declared) {
    return {
      manager: declared,
      source: "packageManager",
      evidence: manifest.packageManager as string
    };
  }

  const lockfiles = await existingLockfiles(root);
  const managers = [...new Set(lockfiles.map((entry) => entry.manager))];
  if (managers.length > 1) {
    throw new Error(
      `Ambiguous package manager: found lockfiles for ${managers.join(", ")}; declare packageManager explicitly.`
    );
  }
  const detected = managers[0];
  if (detected) {
    return {
      manager: detected,
      source: "lockfile",
      evidence: lockfiles.filter((entry) => entry.manager === detected).map((entry) => entry.file).join(",")
    };
  }
  return { manager: "npm", source: "default" };
};

const runCommand = (manager: HarnessPackageManager, check: string): [string, ...string[]] => {
  switch (manager) {
    case "bun":
      return ["bun", "--no-env-file", "run", check];
    case "npm":
      return ["npm", "--ignore-scripts", "run", check];
    case "pnpm":
      return ["pnpm", "--ignore-scripts", "run", check];
    case "yarn":
      return ["yarn", "run", check];
  }
};

export const resolvePackageCheckCommand = async (
  root: string,
  manifest: PackageManifestLike,
  check: string,
  expectedScript: string,
  allowedChecks: readonly string[]
): Promise<PackageCheckCommand> => {
  if (!/^[A-Za-z0-9:_-]+$/.test(check) || !allowedChecks.includes(check)) {
    throw new Error(`The check "${check}" is not in the explicit allowlist.`);
  }
  const scripts = manifest.scripts && typeof manifest.scripts === "object"
    ? manifest.scripts as Record<string, unknown>
    : {};
  const actual = scripts[check];
  if (typeof actual !== "string") {
    throw new Error(`package.json does not define the "${check}" script.`);
  }
  if (actual !== expectedScript) {
    throw new Error(`The "${check}" script changed or does not match expectedScript.`);
  }
  for (const lifecycleName of [`pre${check}`, `post${check}`]) {
    if (typeof scripts[lifecycleName] === "string") {
      throw new Error(
        `The approved "${check}" check has an implicit ${lifecycleName} lifecycle script; approve a standalone script instead.`
      );
    }
  }
  const resolution = await resolvePackageManager(root, manifest);
  return { ...resolution, command: runCommand(resolution.manager, check) };
};
