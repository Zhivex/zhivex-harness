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
const screenshots = [];
const commands = [];
let fault;
await page.route("**/api/action", async (route) => {
  const body = route.request().postDataJSON();
  if (["create", "rename", "start", "decide", "cancel"].includes(body.action))
    commands.push(body.action);
  const selectedFault = fault?.action === body.action ? fault : undefined;
  if (!selectedFault) return route.continue();
  fault = undefined;
  if (selectedFault.mode === "delay")
    await new Promise((resolve) => setTimeout(resolve, 500));
  if (selectedFault.mode === "lost" && body.action === "start") {
    const admitted = route.fetch();
    await page.waitForFunction(
      () => document.querySelector(".pill")?.textContent === "running",
    );
    await route.abort("failed");
    void admitted.catch(() => {});
    return;
  }
  const response = await route.fetch();
  if (selectedFault.mode === "lost") return route.abort("failed");
  if (selectedFault.mode === "expired" || selectedFault.mode === "stale") {
    const value = await response.json();
    if (selectedFault.mode === "stale") value.revision--;
    else
      value.items.forEach((item) => {
        item.expiresAt = Date.now() + 1000;
      });
    return route.fulfill({ response, json: value });
  }
  return route.fulfill({ response });
});
async function capture(name) {
  await page.screenshot({ path: path.join(output, name), fullPage: true });
  screenshots.push(name);
}
async function reconnectState() {
  await page.getByRole("button", { name: "Reconnect" }).click();
  await page
    .getByText("Reading durable state…", { exact: true })
    .waitFor({ state: "hidden" });
}
async function createSession() {
  await page.getByRole("button", { name: "New session", exact: true }).click();
  await page.waitForFunction(
    () => document.querySelector(".pill")?.textContent === "Ready",
  );
}
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
  fault = { action: "sessions", mode: "delay" };
  await page.goto(ready.launchUrl);
  await page.getByText("Loading sessions…", { exact: true }).waitFor();
  await capture("web-loading-desktop.png");
  await page
    .getByRole("button", { name: "Create a session", exact: true })
    .waitFor();
  // A context read may fail after pairing/reload. Reconnect must bootstrap the UI.
  await page.route("**/api/context", async (route) => {
    await page.unroute("**/api/context");
    await route.abort("failed");
  });
  await page.reload();
  await page.getByRole("alert").waitFor();
  await capture("web-initial-error-desktop.png");
  await reconnectState();
  await page
    .getByRole("button", { name: "Create a session", exact: true })
    .waitFor();
  steps.push("recover initial context failure without re-pairing or replay");
  await page.getByLabel("Search sessions").fill("missing-session");
  await page
    .getByText("No sessions match your search.", { exact: true })
    .waitFor();
  await page.getByLabel("Search sessions").fill("");
  steps.push("explicit empty and filtered session states");
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
  await page
    .getByRole("button", { name: "Next change", exact: true })
    .press("Enter");
  assert.equal(
    await page.evaluate(() =>
      document.activeElement?.hasAttribute("data-diff-change"),
    ),
    true,
  );
  steps.push("keyboard diff navigation and focused review heading");
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
    ["completed", "failed", "cancelled", "Reconciliation required"].includes(
      document.querySelector(".pill")?.textContent,
    ),
  );
  if (
    (await page.getByRole("button", { name: "Run task" }).isEnabled()) ===
      false &&
    (await page.getByRole("alert").count())
  )
    await reconnectState();
  steps.push("deny operation and reconcile its failure receipt");
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
      document.querySelector(".pill")?.textContent ===
        "Reconciliation required" ||
      document.querySelector(".pill")?.textContent === "State unavailable" ||
      document.querySelector(".pill")?.textContent === "failed",
  );
  await reconnectState();
  steps.push(
    "sanitized provider error with current run state and explicit reconciliation",
  );
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
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.getByRole("combobox").selectOption({ label: "atlas" });
  await page
    .getByRole("button", { name: "New session", exact: true })
    .waitFor();
  await createSession();
  const startsBefore = commands.filter((c) => c === "start").length;
  await page
    .getByLabel("Task prompt")
    .fill("wait-for-cancel: preserve this draft");
  fault = { action: "start", mode: "lost" };
  await page.getByRole("button", { name: "Run task" }).click();
  await page.getByRole("alert").waitFor();
  assert.equal(
    await page.getByLabel("Task prompt").inputValue(),
    "wait-for-cancel: preserve this draft",
  );
  await page.getByLabel("Task prompt").press("Control+Enter");
  assert.equal(commands.filter((c) => c === "start").length, startsBefore + 1);
  assert.equal(
    await page.getByRole("button", { name: "Run task" }).isEnabled(),
    false,
  );
  await capture("web-uncertain-start-desktop.png");
  await reconnectState();
  await page.waitForFunction(
    () => document.querySelector(".pill")?.textContent === "running",
  );
  assert.equal(commands.filter((c) => c === "start").length, startsBefore + 1);
  const cancelsBefore = commands.filter((c) => c === "cancel").length;
  fault = { action: "cancel", mode: "delay" };
  await page.getByRole("button", { name: "Cancel run" }).evaluate((button) => {
    button.click();
    button.click();
  });
  await page.waitForFunction(
    () => document.querySelector(".pill")?.textContent === "cancelled",
  );
  assert.equal(
    commands.filter((c) => c === "cancel").length,
    cancelsBefore + 1,
  );
  steps.push(
    "lost admitted start retains draft, blocks repeat and reconciles without replay; repeated cancel dispatches once",
  );

  await createSession();
  await writeFile(ready.workspace + "/review.txt", "before\n");
  const repeatedStarts = commands.filter((c) => c === "start").length;
  fault = { action: "start", mode: "delay" };
  await page.getByLabel("Task prompt").fill("edit-probe: repeated start");
  await page.getByRole("button", { name: "Run task" }).evaluate((button) => {
    button.click();
    button.click();
  });
  await wait();
  assert.equal(
    commands.filter((c) => c === "start").length,
    repeatedStarts + 1,
  );
  steps.push("same-render repeated start dispatches once");

  fault = { action: "review", mode: "stale" };
  await page
    .getByRole("button", { name: "Review proposed operation" })
    .press("Enter");
  await page
    .getByText("The run changed. Load a fresh review before deciding.", {
      exact: true,
    })
    .waitFor();
  assert.equal(
    await page.getByRole("button", { name: "Approve & continue" }).isEnabled(),
    false,
  );
  assert.equal(
    await page.getByRole("button", { name: "Deny operation" }).isEnabled(),
    false,
  );
  await capture("web-stale-review-desktop.png");
  fault = { action: "review", mode: "expired" };
  await page.getByRole("button", { name: "Refresh exact review" }).click();
  await page
    .getByText("This review expired. Load a fresh review before deciding.", {
      exact: true,
    })
    .waitFor();
  assert.equal(
    await page.getByRole("button", { name: "Approve & continue" }).isEnabled(),
    false,
  );
  await page.getByRole("button", { name: "Refresh exact review" }).click();
  await page.waitForFunction(
    () => document.activeElement?.textContent === "Exact pending operation",
  );
  steps.push(
    "stale and expired review disables both decisions and requires a fresh ticket",
  );

  for (const width of [320, 390, 768, 1280, 1440]) {
    await page.setViewportSize({ width, height: 1000 });
    assert.equal(
      await page.evaluate(
        () => document.documentElement.scrollWidth > innerWidth,
      ),
      false,
      `overflow at ${width}`,
    );
  }
  await page.setViewportSize({ width: 390, height: 844 });
  await page.getByRole("link", { name: "Go to pending review" }).press("Enter");
  assert.equal(
    await page.evaluate(() => document.activeElement?.id),
    "review-panel",
  );
  await capture("web-review-mobile.png");
  await context.setOffline(true);
  await page.waitForFunction(
    () =>
      document.querySelector(".pill")?.textContent === "Connection unavailable",
  );
  assert.equal(
    await page.getByRole("button", { name: "Approve & continue" }).isEnabled(),
    false,
  );
  assert.equal(
    await page.getByRole("button", { name: "Deny operation" }).isEnabled(),
    false,
  );
  await capture("web-disconnected-review-mobile.png");
  await context.setOffline(false);
  await reconnectState();
  await page.getByRole("button", { name: "Review proposed operation" }).click();
  const decisionsBefore = commands.filter((c) => c === "decide").length;
  fault = { action: "decide", mode: "lost" };
  await page.getByRole("button", { name: "Approve & continue" }).click();
  await page.getByRole("alert").waitFor();
  await reconnectState();
  await complete();
  assert.equal(
    commands.filter((c) => c === "decide").length,
    decisionsBefore + 1,
  );
  assert.match(
    await readFile(ready.workspace + "/review.txt", "utf8"),
    /^after/,
  );
  steps.push(
    "320/390/768/1280/1440 layout, keyboard review jump, disconnected decisions disabled, lost approval reconciled exactly once",
  );

  await page.getByLabel("Task prompt").fill("draft for atlas");
  await page.getByRole("combobox").selectOption({ label: "beacon" });
  await page
    .getByRole("button", { name: "Create a session", exact: true })
    .waitFor();
  await page
    .getByRole("button", { name: "Create a session", exact: true })
    .click();
  await page.waitForFunction(
    () => document.querySelector(".pill")?.textContent === "Ready",
  );
  assert.equal(await page.getByLabel("Task prompt").inputValue(), "");
  await page.getByLabel("Task prompt").fill("draft for beacon");
  await createSession();
  await page
    .getByRole("navigation", { name: "Sessions" }).getByRole("button")
    .last()
    .click();
  await page.waitForFunction(
    () => document.querySelector(".pill")?.textContent === "Ready",
  );
  assert.equal(
    await page.getByLabel("Task prompt").inputValue(),
    "draft for beacon",
  );
  await page.getByRole("combobox").selectOption({ label: "atlas" });
  await page.waitForFunction(() => document.querySelector(".pill")?.textContent === "completed");
  assert.equal(await page.getByLabel("Task prompt").inputValue(), "draft for atlas");
  steps.push("in-memory drafts stay scoped to the selected session and workspace");
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
      ...screenshots,
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
