import assert from "node:assert/strict";
import { fork, spawnSync } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";
import { limitsJourney } from "./limits-journey.mjs";
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
  if (["create", "rename", "start", "decide", "cancel", "selectModel", "configureLimits"].includes(body.action))
    commands.push(body.action);
  const selectedFault = fault?.action === body.action ? fault : undefined;
  if (!selectedFault) return route.continue();
  if (!selectedFault.persistent) fault = undefined;
  if (selectedFault.mode === "absent") return route.fulfill({
    status: 200, contentType: "application/json", body: "null",
  });
  if (selectedFault.mode === "rejected" && selectedFault.delay)
    await new Promise(resolve => setTimeout(resolve, selectedFault.delay));
  if (selectedFault.mode === "rejected") return route.fulfill({
    status: 400, json: { ok: false, error: { code: selectedFault.code } },
  });
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
async function capture(name, fullPage = true) {
  await page.screenshot({ path: path.join(output, name), fullPage });
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
  await page.waitForFunction(
    () => document.querySelector(".pill")?.textContent === "Ready",
  );
  await page.screenshot({
    path: path.join(output, "web-workspace-desktop.png"),
    fullPage: true,
  });
  steps.push("start and workspace selection");
  await limitsJourney(page, capture, commands);
  steps.push("option 3: limits focus/Escape/cancel/no-change, keyboard invalid inputs, persisted project refresh, distinct steps/tools and mobile overflow");
  const beforeSlow = commands.filter(c => c === "start").length;
  await page.getByLabel("Task prompt").fill("wait-for-cancel: composer slow run");
  await page.getByLabel("Task prompt").press("Control+Enter");
  await page.waitForFunction(() => document.querySelector(".pill")?.textContent === "running");
  assert.equal(await page.getByLabel("Task prompt").inputValue(), "");
  await page.getByLabel("Task prompt").fill("wait-for-cancel: composer slow run");
  await page.getByLabel("Task prompt").press("Control+Enter");
  assert.equal(commands.filter(c => c === "start").length, beforeSlow + 1);
  await page.getByRole("button", { name: "Cancel run" }).click();
  await page.waitForFunction(() => document.querySelector(".pill")?.textContent === "cancelled");
  assert.equal(await page.getByLabel("Task prompt").inputValue(), "wait-for-cancel: composer slow run");
  await createSession();
  await task("composer-success");
  await page.getByLabel("Task prompt").fill("next task after success");
  await complete();
  assert.equal(await page.getByLabel("Task prompt").inputValue(), "next task after success");
  for (const code of ["WEB_LIMIT_SETTINGS_INVALID", "WEB_LIMIT_STORAGE_UNSAFE", "WEB_REQUEST_FAILED"]) {
    // Reload can race the outgoing document polling; keep the read fault active
    // until the reloaded document demonstrates the failure and blocks dispatch.
    fault = { action: "runLimits", mode: "rejected", code, persistent: true };
    await page.reload();
    await page.getByRole("alert").filter({ hasText: code.replaceAll("_", " ") }).waitFor({ timeout: 5000 });
    await page.getByLabel("Task prompt").fill("snapshot read failure must block dispatch");
    assert.equal(await page.getByRole("button", { name: "Run task" }).isDisabled(), true);
    fault = undefined;
    await reconnectState();
    await page.getByRole("alert").waitFor({ state: "hidden" });
  }
  fault = { action: "runLimits", mode: "absent", persistent: true };
  await page.reload();
  await page.getByLabel("Task prompt").fill("a legacy run without a snapshot stays healthy");
  await page.getByRole("button", { name: "Run task" }).and(page.locator(":enabled")).waitFor();
  assert.equal(await page.getByRole("alert").count(), 0);
  fault = undefined;
  steps.push("failed limit snapshot reads surface storage/network diagnostics and block dispatch; successful legacy null remains healthy");
  await createSession();
  steps.push("slow run clears composer immediately; identical edit survives completion; Ctrl+Enter cannot replay; success preserves newer draft");
  for (const newer of ["a different draft", "composer rejected submission", ""]) {
    fault = { action: "start", mode: "rejected", code: "INVALID_STATE", delay: 500 };
    await page.getByLabel("Task prompt").fill("composer rejected submission");
    await page.getByRole("button", { name: "Run task" }).click();
    assert.equal(await page.getByLabel("Task prompt").inputValue(), "");
    if (!newer) await page.getByLabel("Task prompt").fill("temporary edit");
    await page.getByLabel("Task prompt").fill(newer);
    await page.getByRole("alert").waitFor();
    assert.equal(await page.getByLabel("Task prompt").inputValue(), newer);
    await page.getByText("Recover submitted text", { exact: true }).click();
    assert.equal(await page.locator(".composer-recovery pre").textContent(), "composer rejected submission");
    const restore = page.getByRole("button", { name: "Restore to empty composer" });
    assert.equal(await restore.isEnabled(), newer === "");
    if (!newer) {
      await restore.click();
      assert.equal(await page.getByLabel("Task prompt").inputValue(), "composer rejected submission");
    }
    await reconnectState();
    await createSession();
  }
  steps.push("failure retains different/identical/cleared newer drafts; submitted text remains explicitly recoverable without overwrite or replay");
  assert.equal(await page.evaluate(() => location.hash), "");
  await task("edit-probe: replace before with after");
  await wait();
  assert.equal(await page.getByLabel("Task prompt").inputValue(), "");
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
  assert(await page.locator("img").evaluateAll(images => images.every(img => new URL(img.src).pathname === "/zhivex-icon.png")));
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
  await page.locator(".operation-status").waitFor({ state: "hidden" });
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
  assert(await page.locator("img").evaluateAll(images => images.every(img => new URL(img.src).pathname === "/zhivex-icon.png")));
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
  await createSession();
  await task("diagnostic-probe");
  await page.getByRole("alert").filter({ hasText: "QWEN SSE EVENT INVALID" }).waitFor();
  await page.getByLabel("Assistant response").filter({ hasText: "QWEN_SSE_EVENT_INVALID" }).waitFor();
  assert.equal((await page.locator("body").innerText()).includes("PRIVATE"), false);
  assert.equal((await page.locator("body").innerText()).includes("sk-never-expose-fixturetoken"), false);
  await reconnectState();
  await page.reload();
  await page.getByLabel("Assistant response").filter({ hasText: "QWEN_SSE_EVENT_INVALID" }).waitFor();
  assert.equal((await page.locator("body").innerText()).includes("PRIVATE"), false);
  steps.push("sanitized Qwen command failure and failed-run projection survive reconnect/reload alongside limits without raw provider/parser fields");
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
  await page.getByRole("combobox", { name: "WORKSPACE", exact: true }).selectOption({ label: "beacon" });
  await page
    .getByRole("button", { name: "Create a session", exact: true })
    .waitFor();
  steps.push("allowlisted workspace switch");
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.getByRole("combobox", { name: "WORKSPACE", exact: true }).selectOption({ label: "atlas" });
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
  assert.equal(await page.getByLabel("Task prompt").inputValue(), "");

  // Polling can reveal the approval while the deliberately delayed start
  // response still owns the mutation lock. Keyboard press does not wait for
  // disabled controls to become actionable as click does.
  await page.getByRole("button", { name: "Review proposed operation" })
    .and(page.locator(":enabled")).waitFor();
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
  await page.getByRole("combobox", { name: "WORKSPACE", exact: true }).selectOption({ label: "beacon" });
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
  await page.getByRole("combobox", { name: "WORKSPACE", exact: true }).selectOption({ label: "atlas" });
  await page.waitForFunction(() => document.querySelector(".pill")?.textContent === "completed");
  assert.equal(await page.getByLabel("Task prompt").inputValue(), "draft for atlas");
  steps.push("in-memory drafts stay scoped to the selected session and workspace");
  await page.getByLabel("Provider and model").waitFor();
  await page.waitForFunction(() => document.querySelector("#model-choice")?.querySelectorAll("option").length === 3);
  const picker = page.getByLabel("Provider and model");
  assert.equal(await picker.locator('option', {hasText: "Fixture missing"}).isDisabled(), true);
  const originalModel = await picker.inputValue();
  await picker.selectOption(JSON.stringify(["anthropic", "fixture-next"]));
  assert.equal(await page.getByLabel("Task prompt").inputValue(), "draft for atlas");
  await page.getByRole("button", {name: "Apply model", exact: true}).click();
  await page.waitForFunction(() => document.querySelector("#model-choice")?.value === JSON.stringify(["anthropic", "fixture-next"]) && !document.querySelector("#model-choice")?.disabled);
  await page.reload();
  await page.waitForFunction(() => document.querySelector("#model-choice")?.value === JSON.stringify(["anthropic", "fixture-next"]) && !document.querySelector("#model-choice")?.disabled);
  steps.push("configured provider/model changes explicitly apply to future tasks and survive reload; unavailable credentials stay disabled");
  await task("markdown-probe: show the numbered plan safely");
  await page.getByRole("heading", {name: "Short-term plan", exact: true}).waitFor();
  await complete();
  assert.equal(await page.locator(".assistant-response strong", {hasText: "Enable critical conformance gates"}).count(), 1);
  assert.equal(await page.locator(".assistant-response img, .assistant-response script").count(), 0);
  assert.equal(await page.locator('.assistant-response a[href^="javascript:"]').count(), 0);
  assert.equal(await page.locator('.assistant-response a[href="https://example.com/docs"]').getAttribute("rel"), "noreferrer noopener");
  await page.setViewportSize({width:1440,height:1000});
  await capture("web-chat-markdown-desktop.png");
  await page.setViewportSize({width:390,height:844});
  await capture("web-chat-markdown-mobile.png");
  assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
  await page.setViewportSize({width:1440,height:1000});
  steps.push("Chat logo and safe Markdown render numbered plans/code/links without executable HTML, script URLs or remote image loads");
  await writeFile(ready.workspace + "/review.txt", "before\n");
  await task("edit-probe: preserve pending approval model");
  await wait();
  assert.equal(await picker.isDisabled(), true);
  steps.push("provider/model selection stays disabled while exact approval is pending");
  await page.getByRole("button", {name:"Review proposed operation"}).click();
  await page.getByRole("button", {name:"Deny operation"}).click();
  await page.waitForFunction(() => ["completed", "failed", "cancelled", "Reconciliation required"].includes(document.querySelector(".pill")?.textContent));
  await page.getByRole("button", { name: "Reconnect" }).click();
  await page.waitForFunction(() => !document.querySelector("#model-choice")?.disabled);
  await picker.selectOption(originalModel);
  await page.getByRole("button", {name:"Apply model",exact:true}).click();
  await page.waitForFunction(value => document.querySelector("#model-choice")?.value === value && !document.querySelector("#model-choice")?.disabled, originalModel);

  // Another paired tab has active work while this tab sees an idle session.
  // The real host rejects the switch before replacing its owner.
  const background = await context.newPage();
  await background.addInitScript(csrf => {
    if (csrf) globalThis.sessionStorage.setItem("zhivex-web-csrf", csrf);
  }, await page.evaluate(() => globalThis.sessionStorage.getItem("zhivex-web-csrf")));
  await background.goto(ready.origin);
  await background.locator('.session-row').filter({hasText:"wait-for-cancel: preserve this draft"}).click();
  await background.waitForFunction(() => document.querySelector(".pill")?.textContent === "cancelled");
  await background.getByLabel("Task prompt").fill("wait-for-cancel: background active run");
  await background.getByRole("button", {name:"Run task", exact:false}).click();
  await background.waitForFunction(() => document.querySelector(".pill")?.textContent === "running");
  await picker.selectOption(JSON.stringify(["anthropic", "fixture-next"]));
  const busyResponse = page.waitForResponse(response => response.url().endsWith("/api/action") && response.request().postDataJSON()?.action === "selectModel");
  await page.getByRole("button", {name:"Apply model",exact:true}).click();
  assert.equal((await (await busyResponse).json()).error.code, "WEB_MODEL_CHANGE_BUSY");
  await page.getByRole("alert").filter({hasText:/Model unchanged/}).waitFor();
  assert.equal(await picker.isEnabled(), true);
  assert.equal(await page.locator('.session-row:disabled').count(), 0);
  assert.notEqual(await page.locator('.pill').textContent(), "Reconciliation required");
  await capture("web-model-rejected-desktop.png");
  await page.locator('.session-row').filter({hasText:"wait-for-cancel: preserve this draft"}).click();
  await page.waitForFunction(() => document.querySelector(".pill")?.textContent === "running");
  assert.equal(await page.getByRole("button", {name:"Cancel run",exact:true}).isEnabled(), true);
  const modelRejectCancels = commands.filter(c => c === "cancel").length;
  await page.getByRole("button", {name:"Cancel run",exact:true}).click();
  await page.waitForFunction(() => document.querySelector(".pill")?.textContent === "cancelled");
  assert.equal(commands.filter(c => c === "cancel").length, modelRejectCancels + 1);
  await background.close();
  steps.push("real cross-session busy model rejection preserves navigation and cancellation without reconnect or owner change");

  fault = {action:"selectModel",mode:"rejected",code:"WEB_MODEL_NOT_CONFIGURED"};
  await page.getByRole("button", {name:"Apply model",exact:true}).click();
  await page.getByRole("alert").filter({hasText:/no longer configured/}).waitFor();
  assert.equal(await picker.isEnabled(), true);
  assert.equal(await page.locator('.session-row:disabled').count(), 0);
  assert.equal(await page.getByRole("combobox", {name:"WORKSPACE",exact:true}).isEnabled(), true);
  await createSession();
  steps.push("definitive unconfigured model rejection keeps workspace/session actions available");

  const switchesBeforeLoss = commands.filter(c => c === "selectModel").length;
  fault = {action:"selectModel",mode:"lost"};
  await picker.selectOption(JSON.stringify(["anthropic", "fixture-next"]));
  await page.getByRole("button", {name:"Apply model",exact:true}).click();
  await page.getByRole("alert").getByText("WEB REQUEST FAILED", {exact:true}).waitFor();
  assert.equal(await picker.isDisabled(), true);
  assert(await page.locator('.session-row:disabled').count() > 0);
  await capture("web-model-uncertain-desktop.png");
  await reconnectState();
  await page.waitForFunction(() => document.querySelector("#model-choice")?.value === JSON.stringify(["anthropic", "fixture-next"]) && !document.querySelector("#model-choice")?.disabled);
  assert.equal(commands.filter(c => c === "selectModel").length, switchesBeforeLoss + 1);
  steps.push("lost admitted model-switch response requires reconciliation and confirms the new host model without replay");

  // A matching code from the later context read is not a model rejection.
  await page.route("**/api/context", async route => {
    await page.unroute("**/api/context");
    await route.fulfill({status:400,json:{ok:false,error:{code:"WEB_MODEL_CHANGE_BUSY"}}});
  });
  await picker.selectOption(originalModel);
  const switchesBeforeContext = commands.filter(c => c === "selectModel").length;
  await page.getByRole("button", {name:"Apply model",exact:true}).click();
  await page.getByRole("alert").getByText("WEB MODEL CHANGE BUSY", {exact:true}).waitFor();
  await page.waitForFunction(() => document.querySelector('.pill')?.textContent === "Reconciliation required");
  assert.equal(await picker.isDisabled(), true);
  await reconnectState();
  await page.waitForFunction(value => document.querySelector("#model-choice")?.value === value && !document.querySelector("#model-choice")?.disabled, originalModel);
  assert.equal(commands.filter(c => c === "selectModel").length, switchesBeforeContext + 1);
  steps.push("context failure after an admitted model switch remains uncertain even with a pre-admission-looking error code");

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
