import { constants as fsConstants } from "node:fs";
import { lstat, mkdir, open, unlink } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { z } from "zod";

import {
  PROVIDERS,
  type HarnessConfigInput,
  type HarnessProvider
} from "./config.js";
import { HarnessConfigError } from "./errors.js";
import {
  FileChangedWhileReadingError,
  FileSizeLimitError,
  UnsafeFileTypeError,
  readRegularFileNoFollow
} from "./file-security.js";

export const CLI_PROFILE_SCHEMA_VERSION = 1 as const;
export const CLI_PROFILE_CONFIG_DIRECTORY_ENV = "ZHIVEX_HARNESS_CONFIG_DIR" as const;
export const MAX_CLI_PROFILE_BYTES = 16 * 1024;

const profileNamePattern = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

export const cliProfileSchema = z.strictObject({
  schemaVersion: z.literal(CLI_PROFILE_SCHEMA_VERSION),
  provider: z.enum(PROVIDERS),
  model: z.string()
    .min(1)
    .max(512)
    .refine((value) => !/[\u0000-\u001f\u007f]/.test(value), "model must contain printable characters")
});

export type CliProfile = z.infer<typeof cliProfileSchema>;

export interface CliProfilePathContext {
  env?: NodeJS.ProcessEnv;
  homeDirectory?: string;
  platform?: NodeJS.Platform;
}

const absoluteDirectory = (
  value: string,
  source: string,
  pathApi: typeof path.posix | typeof path.win32 = path
) => {
  if (!pathApi.isAbsolute(value)) {
    throw new HarnessConfigError(`${source} must be an absolute path.`);
  }
  return pathApi.normalize(value);
};

export const validateCliProfileName = (name: string) => {
  if (!profileNamePattern.test(name)) {
    throw new HarnessConfigError(
      "Profile names must use 1-64 letters, digits, dot, underscore, or hyphen and start with a letter or digit."
    );
  }
  return name;
};

export const resolveCliProfileConfigDirectory = (
  context: CliProfilePathContext = {}
) => {
  const env = context.env ?? process.env;
  const platform = context.platform ?? process.platform;
  const homeDirectory = context.homeDirectory ?? os.homedir();
  const pathApi = platform === "win32" ? path.win32 : path;
  const override = env[CLI_PROFILE_CONFIG_DIRECTORY_ENV]?.trim();
  if (override) {
    return absoluteDirectory(override, CLI_PROFILE_CONFIG_DIRECTORY_ENV, pathApi);
  }

  if (platform === "darwin") {
    return pathApi.join(homeDirectory, "Library", "Application Support", "zhivex-harness");
  }
  if (platform === "win32") {
    const appData = env.APPDATA?.trim();
    if (!appData) {
      throw new HarnessConfigError(
        `APPDATA is required to locate Zhivex Harness profiles on ${platform}.`
      );
    }
    return pathApi.join(absoluteDirectory(appData, "APPDATA", pathApi), "zhivex-harness");
  }

  const xdgConfigHome = env.XDG_CONFIG_HOME?.trim();
  const configHome = xdgConfigHome
    ? absoluteDirectory(xdgConfigHome, "XDG_CONFIG_HOME", pathApi)
    : pathApi.join(homeDirectory, ".config");
  return pathApi.join(configHome, "zhivex-harness");
};

export const resolveCliProfilePath = (
  name: string,
  context: CliProfilePathContext = {}
) => path.join(
  resolveCliProfileConfigDirectory(context),
  "profiles",
  `${validateCliProfileName(name)}.json`
);

const validatePrivateDirectory = async (directory: string) => {
  const directoryStat = await lstat(directory);
  if (!directoryStat.isDirectory() || directoryStat.isSymbolicLink()) {
    throw new HarnessConfigError(`CLI profile directory must be a real directory: ${directory}`);
  }
  if ((directoryStat.mode & 0o022) !== 0) {
    throw new HarnessConfigError(
      `CLI profile directory must not be writable by group or others: ${directory}`
    );
  }
};

const ensurePrivateDirectory = async (directory: string) => {
  try {
    await validatePrivateDirectory(directory);
    return;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  await mkdir(directory, { recursive: true, mode: 0o700 });
  await validatePrivateDirectory(directory);
};

const profileReadError = (profilePath: string, error: unknown): never => {
  if (error instanceof UnsafeFileTypeError) {
    throw new HarnessConfigError(`CLI profile must be a regular non-linked file: ${profilePath}`);
  }
  if (error instanceof FileSizeLimitError) {
    throw new HarnessConfigError(
      `CLI profile exceeds the ${MAX_CLI_PROFILE_BYTES}-byte limit: ${profilePath}`
    );
  }
  if (error instanceof FileChangedWhileReadingError) {
    throw new HarnessConfigError(`CLI profile changed while it was being read: ${profilePath}`);
  }
  const code = error && typeof error === "object" && "code" in error
    ? (error as NodeJS.ErrnoException).code
    : undefined;
  if (code === "ENOENT") {
    throw new HarnessConfigError(
      `CLI profile was not found: ${profilePath}. Create it with zhx init --profile <name>.`
    );
  }
  throw error;
};

export const loadCliProfile = async (
  name: string,
  context: CliProfilePathContext = {}
): Promise<CliProfile> => {
  const profilePath = resolveCliProfilePath(name, context);
  await validatePrivateDirectory(resolveCliProfileConfigDirectory(context));
  await validatePrivateDirectory(path.dirname(profilePath));
  let file: Awaited<ReturnType<typeof readRegularFileNoFollow>>;
  try {
    file = await readRegularFileNoFollow(profilePath, {
      label: `CLI profile ${name}`,
      maxBytes: MAX_CLI_PROFILE_BYTES,
      requireSingleLink: true
    });
  } catch (error) {
    return profileReadError(profilePath, error);
  }
  if ((file.stat.mode & 0o077) !== 0) {
    throw new HarnessConfigError(
      `CLI profile permissions are too broad; expected owner-only access: ${profilePath}`
    );
  }

  let document: unknown;
  try {
    document = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(file.contents));
  } catch {
    throw new HarnessConfigError(`CLI profile is not valid UTF-8 JSON: ${profilePath}`);
  }
  const parsed = cliProfileSchema.safeParse(document);
  if (!parsed.success) {
    throw new HarnessConfigError(
      `CLI profile is invalid: ${parsed.error.issues[0]?.message ?? "schema mismatch"}`
    );
  }
  return parsed.data;
};

export const createCliProfile = async (
  name: string,
  input: { provider: HarnessProvider; model: string },
  context: CliProfilePathContext = {}
) => {
  const parsed = cliProfileSchema.safeParse({
    schemaVersion: CLI_PROFILE_SCHEMA_VERSION,
    provider: input.provider,
    model: input.model
  });
  if (!parsed.success) {
    throw new HarnessConfigError(
      `CLI profile is invalid: ${parsed.error.issues[0]?.message ?? "schema mismatch"}`
    );
  }
  const profile = parsed.data;
  const profilePath = resolveCliProfilePath(name, context);
  await ensurePrivateDirectory(resolveCliProfileConfigDirectory(context));
  await ensurePrivateDirectory(path.dirname(profilePath));

  let handle;
  try {
    handle = await open(
      profilePath,
      fsConstants.O_WRONLY |
        fsConstants.O_CREAT |
        fsConstants.O_EXCL |
        fsConstants.O_NOFOLLOW,
      0o600
    );
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") {
      throw new HarnessConfigError(
        `CLI profile already exists: ${profilePath}. Choose another --profile name.`
      );
    }
    throw error;
  }

  let completed = false;
  try {
    await handle.chmod(0o600);
    await handle.writeFile(`${JSON.stringify(profile, null, 2)}\n`, "utf8");
    await handle.sync();
    const fileStat = await handle.stat();
    if (!fileStat.isFile() || fileStat.nlink !== 1 || (fileStat.mode & 0o077) !== 0) {
      throw new HarnessConfigError(`CLI profile could not be created safely: ${profilePath}`);
    }
    completed = true;
  } finally {
    try {
      await handle.close();
    } finally {
      if (!completed) await unlink(profilePath).catch(() => undefined);
    }
  }

  return { path: profilePath, profile };
};

export const applyCliProfile = async <T extends HarnessConfigInput & { profile?: string }>(
  options: T,
  context: CliProfilePathContext = {}
): Promise<T> => {
  if (!options.profile) return options;
  const profile = await loadCliProfile(options.profile, context);
  return {
    provider: profile.provider,
    model: profile.model,
    ...options
  };
};
