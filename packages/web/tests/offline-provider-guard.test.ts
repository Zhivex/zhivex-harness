import { expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const guard = fileURLToPath(new URL("../scripts/offline-provider-guard.mjs", import.meta.url));
const probe = `for(let i=0;i<2;i++){try{await fetch("https://fixture.invalid/");throw Error("GUARD_MISSING")}catch(error){if(error.message!=="INSTALLED_SMOKE_NETWORK_DENIED")throw error}}if(globalThis.fixtureInjected)throw Error("PATH_EXECUTED");console.log("blocked twice");`;

test("static provider guard treats adversarial paths only as data and blocks every request", async () => {
  const root = await mkdtemp("/tmp/zcw-guard-");
  try {
    const filename = path.join(root, 'spaces " \\ ` ${globalThis.fixtureInjected=true} \n\u2028\u2029 </script>', "attempts.log");
    await mkdir(path.dirname(filename), { recursive: true });
    const result = spawnSync("node", ["--import", guard, "--input-type=module", "--eval", probe], {
      encoding: "utf8", env: { PATH: process.env.PATH, CODE_WEB_PROVIDER_ATTEMPTS_FILE: filename }, timeout: 10000,
    });
    expect(result.status).toBe(0);
    expect(result.stdout).toBe("blocked twice\n");
    expect(await readFile(filename, "utf8")).toBe("attempt\nattempt\n");
    expect((await stat(filename)).mode & 0o777).toBe(0o600);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("missing or relative attempts-file configuration fails before the provider probe", () => {
  for (const filename of ["", "relative-attempts.log"]) {
    const result = spawnSync("node", ["--import", guard, "--input-type=module", "--eval", probe], {
      encoding: "utf8", env: { PATH: process.env.PATH, CODE_WEB_PROVIDER_ATTEMPTS_FILE: filename }, timeout: 10000,
    });
    expect(result.status).not.toBe(0);
    expect(result.stdout).toBe("");
    expect(result.stderr).toContain("INSTALLED_SMOKE_ATTEMPTS_FILE_REQUIRED");
  }
});
