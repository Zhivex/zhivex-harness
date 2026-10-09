import assert from "node:assert/strict";
import path from "node:path";
import { build } from "vite";

/** Exercise the shared hook with real React renders, independently of host tickets. */
export async function reviewUIJourney(browser, root) {
  const result = await build({
    configFile: false,
    root,
    logLevel: "error",
    define: { "process.env.NODE_ENV": JSON.stringify("production") },
    resolve: { dedupe: ["react", "react-dom"] },
    build: {
      write: false,
      lib: { entry: path.join(root, "tests/review-ui-fixture.tsx"), formats: ["iife"], name: "ReviewFixture" },
    },
  });
  const outputs = (Array.isArray(result) ? result : [result]).flatMap(bundle => bundle.output);
  const code = outputs.find(output => output.type === "chunk").code;
  const page = await browser.newPage();
  try {
    await page.setContent('<div id="root"></div>');
    await page.addScriptTag({ content: code });
    const approve = page.getByRole("button", { name: "Approve 2 files + 1 command", exact: true });
    await approve.waitFor();
    assert.equal(await approve.isEnabled(), false);
    assert.equal(await page.getByRole("button", { name: "Reject", exact: true }).isEnabled(), true);
    await page.getByLabel("Viewed a.ts", { exact: true }).check();
    await page.getByText("1 of 2 files viewed", { exact: true }).waitFor();
    assert.equal(await approve.isEnabled(), false);
    await page.getByLabel("Viewed b.ts", { exact: true }).check();
    assert.equal(await approve.isEnabled(), true);
    await page.getByLabel("Viewed a.ts", { exact: true }).uncheck();
    assert.equal(await approve.isEnabled(), false);
    await page.getByLabel("Viewed a.ts", { exact: true }).check();
    for (const change of ["Change revision", "Change run", "Change run", "Change ticket"]) {
      await page.getByRole("button", { name: change, exact: true }).click();
      await page.getByText("0 of 2 files viewed", { exact: true }).waitFor();
      assert.equal(await approve.isEnabled(), false);
      for (const checkbox of await page.getByRole("checkbox").all()) await checkbox.check();
      assert.equal(await approve.isEnabled(), true);
    }
    assert.equal(await page.getByLabel("Decisions").textContent(), "0");
    await page.getByRole("button", { name: "Commands only", exact: true }).click();
    const commands = page.getByRole("button", { name: "Approve 1 command", exact: true });
    assert.equal(await commands.isEnabled(), true);
    await commands.click();
    assert.equal(await page.getByLabel("Decisions").textContent(), "1");
  } finally {
    await page.close();
  }
}
