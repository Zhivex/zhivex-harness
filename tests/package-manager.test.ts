import { describe, expect, test } from "bun:test";
import { mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import {
  resolvePackageCheckCommand,
  resolvePackageManager
} from "../src/package-manager.js";

const fixture = async () => mkdtemp(path.join(os.tmpdir(), "zhivex-harness-package-manager-"));

describe("package manager resolution", () => {
  test("uses an explicit pinned packageManager before lockfile inference", async () => {
    const root = await fixture();
    try {
      await writeFile(path.join(root, "package-lock.json"), "{}\n");
      expect(await resolvePackageManager(root, { packageManager: "pnpm@10.0.0" })).toEqual({
        manager: "pnpm",
        source: "packageManager",
        evidence: "pnpm@10.0.0"
      });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("detects each supported lockfile and defaults to npm", async () => {
    for (const [file, manager] of [
      ["package-lock.json", "npm"],
      ["pnpm-lock.yaml", "pnpm"],
      ["yarn.lock", "yarn"],
      ["bun.lock", "bun"]
    ] as const) {
      const root = await fixture();
      try {
        await writeFile(path.join(root, file), "fixture\n");
        expect((await resolvePackageManager(root, {})).manager).toBe(manager);
      } finally {
        await rm(root, { recursive: true, force: true });
      }
    }
    const root = await fixture();
    try {
      expect(await resolvePackageManager(root, {})).toEqual({ manager: "npm", source: "default" });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("fails closed for ambiguous or symbolic-link lockfiles", async () => {
    const root = await fixture();
    const outside = await fixture();
    try {
      await writeFile(path.join(root, "package-lock.json"), "{}\n");
      await writeFile(path.join(root, "yarn.lock"), "fixture\n");
      await expect(resolvePackageManager(root, {})).rejects.toThrow("Ambiguous package manager");
      await rm(path.join(root, "yarn.lock"));
      await rm(path.join(root, "package-lock.json"));
      await writeFile(path.join(outside, "pnpm-lock.yaml"), "fixture\n");
      await symlink(path.join(outside, "pnpm-lock.yaml"), path.join(root, "pnpm-lock.yaml"));
      await expect(resolvePackageManager(root, {})).rejects.toThrow("must not be a symbolic link");
    } finally {
      await rm(root, { recursive: true, force: true });
      await rm(outside, { recursive: true, force: true });
    }
  });

  test("builds argv-only commands and rejects hidden lifecycle hooks", async () => {
    const root = await fixture();
    try {
      for (const [packageManager, expected] of [
        ["npm@11.5.1", ["npm", "--ignore-scripts", "run", "test"]],
        ["pnpm@10.0.0", ["pnpm", "--ignore-scripts", "run", "test"]],
        ["yarn@4.0.0", ["yarn", "run", "test"]],
        ["bun@1.3.7", ["bun", "--no-env-file", "run", "test"]]
      ] as const) {
        const resolved = await resolvePackageCheckCommand(
          root,
          { packageManager, scripts: { test: "node --test" } },
          "test",
          "node --test",
          ["test"]
        );
        expect(resolved.command).toEqual(expected);
      }

      await expect(resolvePackageCheckCommand(
        root,
        { scripts: { pretest: "node unsafe.js", test: "node --test" } },
        "test",
        "node --test",
        ["test"]
      )).rejects.toThrow("implicit pretest lifecycle script");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
