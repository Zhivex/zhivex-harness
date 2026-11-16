import { expect, test } from "bun:test";
import { createPackageWithOptions, extractFile, listPackage, statFile, uncache } from "@electron/asar";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

test("ASAR packaging preserves nested and hidden files with the patched glob and minimatch", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "zhx-asar-compat-"));
  const source = path.join(root, "source");
  const archive = path.join(root, "app.asar");
  try {
    await mkdir(path.join(source, "build", "native"), { recursive: true });
    await writeFile(path.join(source, "package.json"), '{"main":"build/main.cjs"}');
    await writeFile(path.join(source, "build", "main.cjs"), "module.exports = 42;");
    await writeFile(path.join(source, "build", ".metadata"), "hidden fixture");
    await writeFile(path.join(source, "build", "native", "helper.node"), "native fixture");

    await createPackageWithOptions(source, archive, { unpack: "*.node" });

    expect(listPackage(archive, { isPack: false })).toContain("/build/.metadata");
    expect(extractFile(archive, "build/main.cjs").toString()).toBe("module.exports = 42;");
    expect(extractFile(archive, "build/.metadata").toString()).toBe("hidden fixture");
    expect(statFile(archive, "build/native/helper.node")).toMatchObject({ unpacked: true });
    expect(await readFile(path.join(`${archive}.unpacked`, "build/native/helper.node"), "utf8")).toBe("native fixture");
  } finally {
    uncache(archive);
    await rm(root, { recursive: true, force: true });
  }
});
