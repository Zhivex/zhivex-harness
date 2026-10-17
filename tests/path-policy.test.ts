import { expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { isHardIgnored, isSensitiveName } from "../src/workspace/path-policy.js";
import { Workspace } from "../src/workspace/workspace.js";

test("Turkish I does not bypass protected path names", async () => {
  expect("I".toLocaleLowerCase("tr")).toBe("ı");
  expect(".GIT".toLocaleLowerCase("tr")).not.toBe(".git");
  expect("ID_RSA".toLocaleLowerCase("tr")).not.toBe("id_rsa");
  expect("I".toLowerCase()).toBe("i");
  expect(isHardIgnored(".GIT/HEAD")).toBe(true);
  expect(isHardIgnored(".Git/config")).toBe(true);
  expect(isHardIgnored("src/.NPMRC")).toBe(true);
  expect(isHardIgnored("keys/SERVER.PEM")).toBe(true);
  expect(isSensitiveName("ID_RSA")).toBe(true);
  expect(isSensitiveName("ID_ED25519")).toBe(true);
  expect(isSensitiveName(".ENV")).toBe(true);
  expect(isSensitiveName(".ENV.LOCAL")).toBe(true);
  expect(isSensitiveName(".ENV.EXAMPLE")).toBe(false);
  expect(isHardIgnored("src/README.md")).toBe(false);

  const root = await mkdtemp(path.join(os.tmpdir(), "zhivex-turkish-path-"));
  try {
    await writeFile(path.join(root, "ID_RSA"), "secret\n", "utf8");
    const workspace = await Workspace.open(root);
    await expect(workspace.readFile("ID_RSA")).rejects.toThrow("protected");
    await expect(workspace.readFile(".GIT/HEAD")).rejects.toThrow("protected");
    expect(await workspace.readFile("ID_RSA").catch(() => "")).toBe("");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
