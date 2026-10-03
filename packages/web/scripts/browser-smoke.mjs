import assert from "node:assert/strict";
import { fork, spawnSync } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";
const root = fileURLToPath(new URL("../", import.meta.url));
const output =
  process.env.WEB_EVIDENCE_DIRECTORY ?? path.join(root, ".test-output");
await mkdir(output, { recursive: true });
const build = spawnSync(
  "bun",
  [
    "build",
    path.join(root, "tests/fixture-host.ts"),
    "--outfile",
    path.join(root, ".test-output/fixture-host.mjs"),
    "--target",
    "node",
    "--packages",
    "external",
  ],
  { encoding: "utf8" },
);
assert.equal(build.status, 0, build.stderr);
const child = fork(path.join(root, ".test-output/fixture-host.mjs"), [], {
  stdio: ["ignore", "pipe", "pipe", "ipc"],
  env: { PATH: process.env.PATH, NODE_NO_WARNINGS: "1" },
});
let stderr = "";
child.stderr.on("data", (c) => (stderr += c));
const ready = await new Promise((resolve, reject) => {
  const timer = setTimeout(() => reject(new Error("FIXTURE_TIMEOUT")), 10000);
  child.once("message", (m) => {
    clearTimeout(timer);
    resolve(m);
  });
  child.once("exit", () => {
    clearTimeout(timer);
    reject(new Error(stderr));
  });
});
const browser = await chromium.launch({
  headless: true,
  ...(process.env.WEB_BROWSER_PATH
    ? { executablePath: process.env.WEB_BROWSER_PATH }
    : {}),
  args: ["--no-sandbox"],
});
const context = await browser.newContext({
  viewport: { width: 1440, height: 1000 },
});
const page = await context.newPage();
const errors = [];
page.on("pageerror", (e) => errors.push(e.message));
const steps = [];
const wait = () =>
  page.waitForFunction(
    () => document.querySelector(".pill")?.textContent === "waiting approval",
  );
async function task(prompt) {
  await page.getByLabel("Task prompt").fill(prompt);
  await page.getByRole("button", { name: "Run task" }).click();
}
async function complete() {
  await page.waitForFunction(
    () => document.querySelector(".pill")?.textContent === "completed",
  );
  await page
    .getByRole("button", { name: "Run task" })
    .waitFor({ state: "visible" });
}
try {
  await page.goto(ready.launchUrl);
  await page
    .getByRole("button", { name: "Create a session", exact: true })
    .click();
  await page.getByLabel("Task prompt").waitFor({ state: "visible" });
  await page.screenshot({
    path: path.join(output, "web-workspace-desktop.png"),
    fullPage: true,
  });
  steps.push("start and workspace selection");
  assert.equal(await page.evaluate(() => location.hash), "");
  await task("edit-probe: replace before with after");
  await wait();
  await page.reload();
  await wait();
  steps.push("reload and durable resume");
  await page.getByRole("button", { name: "Review proposed operation" }).click();
  await page.getByRole("button", { name: "Approve & continue" }).waitFor();
  await page.screenshot({
    path: path.join(output, "web-review-desktop.png"),
    fullPage: true,
  });
  assert.match(await page.getByLabel("Approval review").innerText(), /before/);
  assert.equal(await page.locator("img").count(), 0);
  await page.getByRole("button", { name: "Approve & continue" }).click();
  await complete();
  assert.match(
    await readFile(ready.workspace + "/review.txt", "utf8"),
    /^after/,
  );
  steps.push("review diff and approve exactly once");
  await task("check-probe: run existing checks");
  await wait();
  await page.getByRole("button", { name: "Review proposed operation" }).click();
  await page.getByRole("button", { name: "Approve & continue" }).click();
  await complete();
  await page.getByText("exit 7", { exact: true }).waitFor();
  steps.push("real offline failed check activity");
  await writeFile(ready.workspace + "/review.txt", "before\n");
  await page.getByRole("button", { name: "New session", exact: true }).click();
  await task("edit-probe: review another edit");
  await wait();
  await page.getByRole("button", { name: "Review proposed operation" }).click();
  await page.getByRole("button", { name: "Deny operation" }).click();
  await page.waitForFunction(() =>
    ["completed", "failed", "cancelled"].includes(
      document.querySelector(".pill")?.textContent,
    ),
  );
  steps.push("deny operation");
  await task("wait-for-cancel");
  await page.waitForFunction(
    () => document.querySelector(".pill")?.textContent === "running",
  );
  await context.setOffline(true);
  await page.getByRole("button", { name: "Reconnect" }).click();
  await page.getByRole("alert").waitFor();
  await context.setOffline(false);
  await page.getByRole("button", { name: "Reconnect" }).click();
  await page.reload();
  await page.waitForFunction(
    () => document.querySelector(".pill")?.textContent === "running",
  );
  await page.getByRole("button", { name: "Cancel run" }).click();
  await page.waitForFunction(
    () => document.querySelector(".pill")?.textContent === "cancelled",
  );
  steps.push("disconnect, reconnect, reload active run and cancel");
  await task("boundary-probe");
  await page.waitForFunction(() =>
    ["completed", "failed"].includes(
      document.querySelector(".pill")?.textContent,
    ),
  );
  assert.equal(await page.locator("img").count(), 0);
  steps.push("engine workspace boundary");
  await task("error-probe");
  await page.waitForFunction(
    () =>
      document.querySelector(".pill")?.textContent === "failed" ||
      document.querySelector("[role=alert]"),
  );
  assert.equal(
    (await page.locator("body").innerText()).includes(
      "sk-never-expose-fixturetoken",
    ),
    false,
  );
  await page.waitForFunction(
    () =>
      document.querySelector(".pill")?.textContent === "State unavailable" ||
      document.querySelector(".pill")?.textContent === "failed",
  );
  steps.push("sanitized provider error with current run state");
  await page.setViewportSize({ width: 390, height: 844 });
  await page.screenshot({
    path: path.join(output, "web-workspace-mobile.png"),
    fullPage: true,
  });
  assert.equal(
    await page.evaluate(
      () => document.documentElement.scrollWidth > innerWidth,
    ),
    false,
  );
  steps.push("mobile layout without horizontal overflow");
  await page.getByRole("combobox").selectOption({ label: "beacon" });
  await page
    .getByRole("button", { name: "Create a session", exact: true })
    .waitFor();
  steps.push("allowlisted workspace switch");
  assert.deepEqual(errors, []);
  const report = {
    passed: true,
    steps,
    browserErrors: errors,
    providerCalls: "offline fixture only",
    screenshots: [
      "web-workspace-desktop.png",
      "web-review-desktop.png",
      "web-workspace-mobile.png",
    ],
  };
  await writeFile(
    path.join(output, "browser-report.json"),
    JSON.stringify(report, null, 2),
  );
  console.log(JSON.stringify(report));
} catch (error) {
  await page.screenshot({
    path: path.join(output, "browser-failure.png"),
    fullPage: true,
  });
  await writeFile(
    path.join(output, "browser-failure.txt"),
    await page.locator("body").innerText(),
  );
  console.error("Completed browser steps:", steps);
  throw error;
} finally {
  await browser.close();
  const stopped = new Promise((resolve) => child.once("exit", resolve));
  child.send("close");
  await stopped;
}
