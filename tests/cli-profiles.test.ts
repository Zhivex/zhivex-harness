import { describe, expect, test } from "bun:test";
import {
  chmod,
  link,
  mkdir,
  mkdtemp,
  rm,
  stat,
  symlink,
  writeFile
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import {
  MAX_CLI_PROFILE_BYTES,
  applyCliProfile,
  createCliProfile,
  loadCliProfile,
  resolveCliProfileConfigDirectory,
  resolveCliProfilePath,
  validateCliProfileName
} from "../src/cli-profiles.js";

const withConfigRoot = async <T>(operation: (
  context: { env: NodeJS.ProcessEnv }
) => Promise<T>) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "zhivex-cli-profiles-"));
  try {
    return await operation({ env: { ZHIVEX_HARNESS_CONFIG_DIR: root } });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
};

describe("CLI profiles", () => {
  test("resolves portable user-owned configuration directories", () => {
    expect(resolveCliProfileConfigDirectory({
      env: {},
      platform: "darwin",
      homeDirectory: "/Users/operator"
    })).toBe("/Users/operator/Library/Application Support/zhivex-harness");
    expect(resolveCliProfileConfigDirectory({
      env: { XDG_CONFIG_HOME: "/var/operator-config" },
      platform: "linux",
      homeDirectory: "/home/operator"
    })).toBe("/var/operator-config/zhivex-harness");
    expect(resolveCliProfileConfigDirectory({
      env: {},
      platform: "linux",
      homeDirectory: "/home/operator"
    })).toBe("/home/operator/.config/zhivex-harness");
    expect(resolveCliProfileConfigDirectory({
      env: { APPDATA: "C:\\Users\\operator\\AppData\\Roaming" },
      platform: "win32",
      homeDirectory: "C:\\Users\\operator"
    }).replaceAll("\\", "/")).toContain("zhivex-harness");
  });

  test("creates owner-only profiles and preserves CLI-over-profile precedence", async () => {
    await withConfigRoot(async (context) => {
      const created = await createCliProfile("daily", {
        provider: "qwen",
        model: "qwen3.8-max"
      }, context);
      expect(created.profile).toEqual({
        schemaVersion: 1,
        provider: "qwen",
        model: "qwen3.8-max"
      });
      expect((await stat(path.dirname(created.path))).mode & 0o777).toBe(0o700);
      expect((await stat(created.path)).mode & 0o777).toBe(0o600);
      expect(await loadCliProfile("daily", context)).toEqual(created.profile);

      expect(await applyCliProfile({ profile: "daily" }, context)).toMatchObject({
        profile: "daily",
        provider: "qwen",
        model: "qwen3.8-max"
      });
      expect(await applyCliProfile({
        profile: "daily",
        provider: "openai",
        model: "gpt-5.6-luna"
      }, context)).toMatchObject({
        provider: "openai",
        model: "gpt-5.6-luna"
      });
    });
  });

  test("never loads a profile implicitly", async () => {
    const options = { provider: "meta" } as const;
    const resolved = await applyCliProfile(options, {
      env: { ZHIVEX_HARNESS_CONFIG_DIR: "/does/not/exist" }
    });
    expect(resolved).toBe(options);
  });

  test("rejects invalid names and existing profiles", async () => {
    expect(() => validateCliProfileName("../escape")).toThrow("Profile names");
    expect(() => validateCliProfileName("space profile")).toThrow("Profile names");
    await withConfigRoot(async (context) => {
      await createCliProfile("daily", { provider: "meta", model: "muse-spark-1.2" }, context);
      await expect(createCliProfile(
        "daily",
        { provider: "openai", model: "gpt-5.6-luna" },
        context
      )).rejects.toThrow("already exists");
    });
  });

  test("rejects unknown fields, broad permissions, oversized files, and links", async () => {
    await withConfigRoot(async (context) => {
      const profileDirectory = path.dirname(resolveCliProfilePath("invalid", context));
      await mkdir(profileDirectory, { recursive: true, mode: 0o700 });

      const invalidPath = resolveCliProfilePath("invalid", context);
      await writeFile(invalidPath, JSON.stringify({
        schemaVersion: 1,
        provider: "openai",
        model: "gpt-5.6-luna",
        apiKey: "must-not-be-accepted"
      }), { mode: 0o600 });
      await expect(loadCliProfile("invalid", context)).rejects.toThrow("Unrecognized key");

      const publicPath = resolveCliProfilePath("public", context);
      await writeFile(publicPath, JSON.stringify({
        schemaVersion: 1,
        provider: "openai",
        model: "gpt-5.6-luna"
      }), { mode: 0o644 });
      await chmod(publicPath, 0o644);
      await expect(loadCliProfile("public", context)).rejects.toThrow("permissions are too broad");

      const largePath = resolveCliProfilePath("large", context);
      await writeFile(largePath, "x".repeat(MAX_CLI_PROFILE_BYTES + 1), { mode: 0o600 });
      await expect(loadCliProfile("large", context)).rejects.toThrow("byte limit");

      const targetPath = resolveCliProfilePath("target", context);
      await writeFile(targetPath, JSON.stringify({
        schemaVersion: 1,
        provider: "meta",
        model: "muse-spark-1.2"
      }), { mode: 0o600 });
      await link(targetPath, resolveCliProfilePath("hardlink", context));
      await symlink(targetPath, resolveCliProfilePath("symlink", context));
      await expect(loadCliProfile("hardlink", context)).rejects.toThrow("regular non-linked file");
      await expect(loadCliProfile("symlink", context)).rejects.toThrow("regular non-linked file");
    });
  });

  test("rejects a linked or writable profile directory", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "zhivex-cli-profile-dir-"));
    const linkedTarget = path.join(root, "linked-target");
    const linkedConfig = path.join(root, "linked-config");
    try {
      await mkdir(path.join(linkedTarget, "profiles"), { recursive: true, mode: 0o700 });
      await symlink(linkedTarget, linkedConfig);
      await expect(createCliProfile("linked", {
        provider: "openai",
        model: "gpt-5.6-luna"
      }, { env: { ZHIVEX_HARNESS_CONFIG_DIR: linkedConfig } })).rejects.toThrow("real directory");

      const writableConfig = path.join(root, "writable-config");
      await mkdir(writableConfig, { mode: 0o777 });
      await chmod(writableConfig, 0o777);
      await expect(createCliProfile("writable", {
        provider: "openai",
        model: "gpt-5.6-luna"
      }, { env: { ZHIVEX_HARNESS_CONFIG_DIR: writableConfig } })).rejects.toThrow(
        "writable by group or others"
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
