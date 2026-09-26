import { expect, spyOn, test } from "bun:test";
import * as fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { readDependency } from "../src/tools/dependency-read.js";

// Reproduce PR #132's proposed ABA: opendir retains the outside directory,
// but the original package inode is restored before any later path check.
for (const replacement of ["symlink", "directory"] as const) {
  for (const action of ["list", "search"] as const) {
    test(`dependency ${action} rejects restored-directory ABA via ${replacement}`, async () => {
      const root = await fs.mkdtemp(path.join(os.tmpdir(), "dependency-aba-"));
      const pkg = path.join(root, "node_modules/library");
      const saved = path.join(root, "saved-package");
      const outside = path.join(root, "outside");
      await fs.mkdir(pkg, { recursive: true });
      await fs.mkdir(outside);
      await fs.writeFile(path.join(pkg, "index.js"), "safe source");
      await fs.writeFile(path.join(outside, "PRIVATE_NAME.txt"), "PRIVATE_CONTENT");
      const before = await fs.lstat(pkg, { bigint: true });
      const original = fs.opendir;
      let swapped = false;
      const intercepted = spyOn(fs, "opendir").mockImplementation(async (...args: Parameters<typeof fs.opendir>) => {
        if (String(args[0]) !== pkg || swapped) return original(...args);
        swapped = true;
        await fs.rename(pkg, saved);
        if (replacement === "symlink") await fs.symlink(outside, pkg);
        else await fs.rename(outside, pkg);
        try {
          return await original(...args);
        } finally {
          if (replacement === "symlink") await fs.unlink(pkg);
          else await fs.rename(pkg, outside);
          await fs.rename(saved, pkg);
        }
      });
      try {
        await expect(readDependency(root, { package: "library", action, query: "PRIVATE" }))
          .rejects.toThrow("Dependency directory changed during inspection");
        expect(swapped).toBe(true);
        const after = await fs.lstat(pkg, { bigint: true });
        expect(after.ino).toBe(before.ino);
        expect(after.ctimeNs).not.toBe(before.ctimeNs);
      } finally {
        intercepted.mockRestore();
        await fs.rm(root, { recursive: true, force: true });
      }
    });
  }
}
