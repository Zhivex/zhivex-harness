import assert from "node:assert/strict";
import { fork, spawnSync } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";
import { reviewUIJourney } from "./review-ui-journey.mjs";
import { uxBrowserJourney } from "./ux-browser-journey.mjs";
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
      () => document.querySelector(".pill")?.textContent === "Running",
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
async function viewReviewFiles() {
  const approve = page.getByRole("button", { name: /^Approve (?:\d+ files?|\d+ commands?)/ });
  await approve.waitFor();
  // Reconnect clears the ticket before the next review arrives. Keep marking files
  // until that later ticket is on screen and Approve is enabled.
  await page.waitForFunction(() => {
    const button = document.querySelector("button[data-decision='approve']");
    if (!button) return false;
    const boxes = [...document.querySelectorAll("[data-action='view-file']")];
    if (/\d+ files?/.test(button.textContent ?? "") && boxes.length === 0) return false;
    for (const box of boxes) {
      if (box.tagName === "INPUT" && !box.checked) box.click();
    }
    return !button.disabled;
  });
}
async function reviewEnterDoesNotDecide() {
  const before = commands.filter(command => command === "decide").length;
  for (const target of await page.locator('.review-content h3, .review-content button:enabled, .review-content input, .review-content summary, .review-content [role="region"]').all()) {
    if ((await target.innerText()).includes("Reload review")) continue;
    for (const key of ["Enter", "Control+Enter", "Meta+Enter"]) await target.press(key);
  }
  assert.equal(commands.filter(command => command === "decide").length, before);
  assert.equal(await page.getByLabel("Approval review").count(), 1);
}
async function capture(name, fullPage = true) {
  await page.screenshot({ path: path.join(output, name), fullPage });
  screenshots.push(name);
}
async function reconnectState() {
  const button = page.getByRole("button", { name: /^(Reconnect|Reconcile)$/ }).first();
  const label = (await button.innerText()).trim();
  await button.click();
  await page.getByRole("button", { name: label, exact: true }).waitFor({ state: "hidden" });
}
async function createSession() {
  await page.getByRole("button", { name: "New session", exact: true }).click();
  await page.waitForFunction(
    () => document.querySelector(".pill")?.textContent === "Ready",
  );
}
const wait = () =>
  page.waitForFunction(
    () => document.querySelector(".pill")?.textContent === "Needs you",
  );
async function openSessions(target = page) {
  if ((await target.locator(".drawer-root").getAttribute("hidden")) !== null)
    await target.getByRole("button", { name: "Sessions", exact: true }).click();
  await target.getByLabel("Search sessions").waitFor();
}
async function closeSessions(target = page) {
  if ((await target.locator(".drawer-root").getAttribute("hidden")) === null)
    await target.getByRole("button", { name: "Close sessions", exact: true }).click();
}
async function openProject(name, target = page) {
  await openSessions(target);
  await target.getByRole("button", { name: `Open project ${name}`, exact: true }).click();
}
async function applyModel(name) {
  await page.getByRole("button", { name: "Provider and model" }).click();
  await page.getByRole("option", { name: new RegExp(name) }).first().click();
}
async function applyOtherModel(fallbackValue) {
  const shown = await page.locator("#model-choice").getAttribute("data-value");
  const next = shown?.endsWith("fixture-next") ? "Fixture current" : "Fixture next";
  const value = shown?.endsWith("fixture-next") ? fallbackValue : "anthropic/fixture-next";
  await applyModel(next);
  return value;
}
async function task(prompt) {
  await page.getByLabel("Task prompt").fill(prompt);
  await page.getByRole("button", { name: "Run task" }).click();
}
async function complete() {
  await page.waitForFunction(
    () => document.querySelector(".pill")?.textContent === "Done",
  );
  await page
    .getByRole("button", { name: "Run task" })
    .waitFor({ state: "visible" });
}
try {
  await reviewUIJourney(browser, root);
  steps.push("shared viewed state resets on revision, run, and ticket changes; duplicate paths count once; commands-only reviews remain ungated");
  fault = { action: "sessions", mode: "delay" };
  await page.goto(ready.launchUrl);
  await page.getByLabel("Task stream").getByText("Loading sessions…", { exact: true }).waitFor();
  await capture("web-loading-desktop.png");
  await page
    .getByLabel("Task prompt")
    .waitFor();
  // Keep failing context until the alert is visible. A one-shot route can be
  // consumed by the background context poll and the reloaded page then looks healthy.
  await page.route("**/api/context", async (route) => {
    await route.abort("failed");
  });
  await page.reload();
  await page.getByRole("alert").waitFor();
  await page.unroute("**/api/context");
  await capture("web-initial-error-desktop.png");
  await reconnectState();
  await page
    .getByLabel("Task prompt")
    .waitFor();
  steps.push("recover initial context failure without re-pairing or replay");
  await openSessions();
  await page.getByLabel("Search sessions").fill("missing-session");
  await page
    .getByText("No sessions match your search.", { exact: true })
    .waitFor();
  await page.getByLabel("Search sessions").fill("");
  await closeSessions();
  steps.push("explicit empty and filtered session states");
  await page.getByLabel("Task prompt").waitFor({ state: "visible" });
  await page.waitForFunction(
    () => document.querySelector(".pill")?.textContent === "Ready",
  );
  await page.screenshot({
    path: path.join(output, "web-workspace-desktop.png"),
    fullPage: true,
  });
  steps.push("start and workspace selection");
  await uxBrowserJourney(context, ready.origin, await page.evaluate(() => globalThis.sessionStorage.getItem("zhivex-web-csrf")));
  steps.push("theme persistence, sessions drawer, model search, narrow diff and shortcuts");
  await limitsJourney(page, capture, commands);
  steps.push("option 3: limits focus/Escape/cancel/no-change, keyboard invalid inputs, persisted project refresh, distinct steps/tools and mobile overflow");
  const beforeSlow = commands.filter(c => c === "start").length;
  await page.getByLabel("Task prompt").fill("wait-for-cancel: composer slow run");
  await page.getByLabel("Task prompt").press("Control+Enter");
  await page.waitForFunction(() => document.querySelector(".pill")?.textContent === "Running");
  assert.equal(await page.getByLabel("Task prompt").inputValue(), "");
  await page.getByLabel("Task prompt").fill("wait-for-cancel: composer slow run");
  await page.getByLabel("Task prompt").press("Control+Enter");
  assert.equal(commands.filter(c => c === "start").length, beforeSlow + 1);
  await page.getByRole("button", { name: "Cancel run" }).click();
  await page.waitForFunction(() => document.querySelector(".pill")?.textContent === "Cancelled");
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
    assert.equal(await page.locator(".composer-recovery pre").textContent(), "composer rejected submission");
    const restore = page.getByRole("button", { name: "Edit message" });
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
  await page.getByLabel("Approval review", { exact: true }).waitFor();
  await page.getByRole("button", { name: /^Approve (?:\d+ files?|\d+ commands?)/ }).waitFor();
  await page.screenshot({
    path: path.join(output, "web-review-desktop.png"),
    fullPage: true,
  });
  const themeBefore = await page.evaluate(() => globalThis.localStorage.getItem("zhivex.code.theme.v1") ?? "system");
  async function chooseTheme(choice) {
    for (let attempt = 0; attempt < 4; attempt++) {
      const current = await page.evaluate(() => globalThis.localStorage.getItem("zhivex.code.theme.v1") ?? "system");
      if (current === choice) return;
      await page.getByRole("button", { name: /Switch theme/ }).click();
    }
    throw new Error(`theme ${choice} not reached`);
  }
  await chooseTheme("light");
  await page.waitForFunction(() => document.querySelector(".app-shell")?.dataset.theme === "light");
  await page.screenshot({ path: path.join(output, "web-review-light.png"), fullPage: true });
  await chooseTheme("dark");
  await page.waitForFunction(() => document.querySelector(".app-shell")?.dataset.theme === "dark");
  await page.screenshot({ path: path.join(output, "web-review-dark.png"), fullPage: true });
  await openSessions();
  await page.screenshot({ path: path.join(output, "web-drawer-dark.png") });
  await closeSessions();
  await chooseTheme("light");
  await page.waitForFunction(() => document.querySelector(".app-shell")?.dataset.theme === "light");
  await openSessions();
  await page.screenshot({ path: path.join(output, "web-drawer-light.png") });
  await closeSessions();
  await chooseTheme(themeBefore);
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
  await page.getByRole("button", { name: "1 needs you", exact: true }).waitFor();
  const widthHandle = page.getByRole("separator", { name: "Diff width" });
  const widthBefore = Number(await widthHandle.getAttribute("aria-valuenow"));
  const widthBox = await widthHandle.boundingBox();
  assert.ok(widthBox);
  await page.mouse.move(widthBox.x + widthBox.width / 2, widthBox.y + 30);
  await page.mouse.down();
  await page.mouse.move(widthBox.x + widthBox.width / 2 + 120, widthBox.y + 30, { steps: 6 });
  await page.mouse.up();
  const widthAfter = Number(await page.getByRole("separator", { name: "Diff width" }).getAttribute("aria-valuenow"));
  assert.ok(widthAfter < widthBefore, `${widthAfter} should be below ${widthBefore}`);
  assert.ok(widthAfter >= 420);
  const dragged = await page.evaluate(() => JSON.parse(document.defaultView.localStorage.getItem("zhivex.code.diffLayout.v1")));
  assert.equal(dragged.widthPx, widthAfter);
  const past = await page.getByRole("separator", { name: "Diff width" }).boundingBox();
  await page.mouse.move(past.x + past.width / 2, past.y + 30);
  await page.mouse.down();
  await page.mouse.move(past.x + 2400, past.y + 30, { steps: 4 });
  await page.mouse.up();
  assert.equal(Number(await page.getByRole("separator", { name: "Diff width" }).getAttribute("aria-valuenow")), 420);
  assert.ok((await page.locator(".chat-column").boundingBox()).width >= 360);
  await page.getByRole("button", { name: "Minimize", exact: true }).click();
  await page.waitForFunction(() => document.querySelector(".workspace-frame")?.getAttribute("data-position") === "minimized");
  assert.equal(await page.locator(".diff-column").count(), 0);
  assert.equal(await page.locator("[data-decision='approve'], [data-decision='reject']").count(), 0);
  assert.equal(await page.locator(".workspace-frame").evaluate(el => el.ownerDocument.defaultView.getComputedStyle(el).gridTemplateColumns.split(" ").filter(Boolean).length), 1);
  await page.getByRole("button", { name: "Restore review", exact: true }).click();
  await page.getByLabel("Approval review", { exact: true }).waitFor();
  steps.push("pointer drag persists the diff width and minimize leaves only the restore bar");
  await openProject("beacon");
  await openSessions();
  await page.getByRole("group", { name: "atlas sessions" }).locator(".session-row").first().waitFor();
  await openProject("atlas");
  await page.getByLabel("Approval review", { exact: true }).waitFor();
  steps.push("a non-current project with pending work shows its sessions when the drawer opens");
  assert.equal(await page.getByRole("button", { name: "Approve 1 file", exact: true }).isEnabled(), false);
  assert.equal(await page.getByRole("button", { name: "Reject", exact: true }).isEnabled(), true);
  await page.getByText("View all files to approve", { exact: true }).waitFor();
  await reviewEnterDoesNotDecide();
  await viewReviewFiles();
  assert.equal(await page.getByRole("button", { name: "Approve 1 file", exact: true }).isEnabled(), true);
  await reviewEnterDoesNotDecide();
  await page.getByRole("button", { name: "Reload review", exact: true }).click();
  await page.getByText("0 of 1 file viewed", { exact: true }).waitFor();
  assert.equal(await page.getByRole("button", { name: "Approve 1 file", exact: true }).isEnabled(), false);
  steps.push("viewed gate blocks approval, leaves rejection available, resets on new ticket; Enter/Ctrl+Enter/Meta+Enter never decide");
  // Stress the rendered review with long unbroken text without changing its ticket or payload.
  const originalText = await page.evaluate(() => {
    const path = document.querySelector('.review-file h4');
    const code = document.querySelector('.diff-line code');
    const original = { path: path.textContent, code: code.textContent };
    path.textContent = 'nested/'.repeat(30) + 'a'.repeat(160) + '.ts';
    code.textContent = 'const veryLongValue = "' + 'x'.repeat(500) + '";';
    return original;
  });
  for (const width of [390, 1120, 1280]) {
    await page.setViewportSize({ width, height: 900 });
    assert.equal(await page.evaluate(() => {
      const selectors = ['.review-file h4', '.diff-line code', '.diff-lines', '.review-scope', '.decision-actions button'];
      return selectors.every(selector => [...document.querySelectorAll(selector)].every(element => {
        const style = document.defaultView.getComputedStyle(element);
        return element.scrollWidth <= element.clientWidth + 1 && style.textOverflow !== 'ellipsis' && style.whiteSpace !== 'nowrap';
      }));
    }), true, `complete review wraps at ${width}px`);
    await capture(`web-review-long-lines-${width}.png`);
  }
  await page.evaluate(original => {
    document.querySelector('.review-file h4').textContent = original.path;
    document.querySelector('.diff-line code').textContent = original.code;
  }, originalText);
  await page.setViewportSize({ width: 1440, height: 1000 });
  steps.push("long paths, diff lines and approval scope wrap at 390, 1120 and 1280px");
  await viewReviewFiles();
  await page.getByRole("button", { name: /^Approve (?:\d+ files?|\d+ commands?)/ }).click();
  await complete();
  assert.match(
    await readFile(ready.workspace + "/review.txt", "utf8"),
    /^after/,
  );
  steps.push("review diff and approve exactly once");
  await task("check-probe: run existing checks");
  await wait();
  await page.getByLabel("Approval review", { exact: true }).waitFor();
  assert.equal(await page.getByRole("button", { name: "Approve 1 command", exact: true }).isEnabled(), true);
  await reviewEnterDoesNotDecide();
  await viewReviewFiles();
  await page.getByRole("button", { name: /^Approve (?:\d+ files?|\d+ commands?)/ }).click();
  await complete();
  await page.getByText("exit 7", { exact: true }).waitFor();
  steps.push("real offline failed check activity");
  await writeFile(ready.workspace + "/review.txt", "before\n");
  await page.getByRole("button", { name: "New session", exact: true }).click();
  await task("edit-probe: review another edit");
  await wait();
  await page.getByLabel("Approval review", { exact: true }).waitFor();
  await page.getByRole("button", { name: "Reject", exact: true }).click();
  await page.waitForFunction(() =>
    ["Done", "Error", "Cancelled", "Refresh needed"].includes(
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
    () => document.querySelector(".pill")?.textContent === "Running",
  );
  // Reconnect stays hidden while the host is connected. The running snapshot
  // and cancellation remain available without that control.
  assert.equal(await page.getByRole("button", { name: "Reconnect" }).count(), 0);
  await page.waitForFunction(
    () => document.querySelector(".pill")?.textContent === "Running",
  );
  assert.equal(
    await page.getByRole("alert").filter({ hasText: "WEB REQUEST FAILED" }).count(),
    0,
  );
  assert.equal(
    await page.getByRole("button", { name: "Cancel run" }).isEnabled(),
    true,
  );
  steps.push(
    "a connected run hides reconnect and keeps cancellation",
  );
  await context.setOffline(true);
  await page.getByRole("button", { name: "Reconnect" }).click();
  await page.getByRole("alert").waitFor();
  await context.setOffline(false);
  await page.getByRole("button", { name: "Reconnect" }).click();
  await page.reload();
  await page.waitForFunction(
    () => document.querySelector(".pill")?.textContent === "Running",
  );
  await page.getByRole("button", { name: "Cancel run" }).click();
  await page.waitForFunction(
    () => document.querySelector(".pill")?.textContent === "Cancelled",
  );
  steps.push("disconnect, reconnect, reload active run and cancel");
  await task("boundary-probe");
  await page.waitForFunction(() =>
    ["Done", "Error"].includes(
      document.querySelector(".pill")?.textContent,
    ),
  );
  assert(await page.locator("img").evaluateAll(images => images.every(img => new URL(img.src).pathname === "/zhivex-icon.png")));
  steps.push("engine workspace boundary");
  await task("error-probe");
  await page.waitForFunction(
    () =>
      document.querySelector(".pill")?.textContent === "Error" ||
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
        "Refresh needed" ||
      document.querySelector(".pill")?.textContent === "Couldn't read this run" ||
      document.querySelector(".pill")?.textContent === "Error",
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
  await openProject("beacon");
  await page
    .getByLabel("Task prompt")
    .waitFor();
  steps.push("allowlisted workspace switch");
  await page.setViewportSize({ width: 1440, height: 1000 });
  await openProject("atlas");
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
    () => document.querySelector(".pill")?.textContent === "Running",
  );
  assert.equal(commands.filter((c) => c === "start").length, startsBefore + 1);
  const cancelsBefore = commands.filter((c) => c === "cancel").length;
  fault = { action: "cancel", mode: "delay" };
  await page.getByRole("button", { name: "Cancel run" }).evaluate((button) => {
    button.click();
    button.click();
  });
  await page.waitForFunction(
    () => document.querySelector(".pill")?.textContent === "Cancelled",
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

  // The review loads on its own. Wait for that ticket, then reload under a fault.
  await page.getByLabel("Approval review", { exact: true }).waitFor();
  fault = { action: "review", mode: "stale" };
  await page.getByRole("button", { name: "Reload review", exact: true }).click();
  await page
    .getByText("The run changed. Load a fresh review before deciding.", {
      exact: true,
    })
    .waitFor();
  assert.equal(
    await page.getByRole("button", { name: /^Approve (?:\d+ files?|\d+ commands?)/ }).isEnabled(),
    false,
  );
  assert.equal(
    await page.getByRole("button", { name: "Reject", exact: true }).isEnabled(),
    false,
  );
  await capture("web-stale-review-desktop.png");
  fault = { action: "review", mode: "expired" };
  await page.getByRole("button", { name: "Reload review", exact: true }).click();
  await page
    .getByText("This review expired. Load a fresh review before deciding.", {
      exact: true,
    })
    .waitFor();
  assert.equal(
    await page.getByRole("button", { name: /^Approve (?:\d+ files?|\d+ commands?)/ }).isEnabled(),
    false,
  );
  await page.getByRole("button", { name: "Reload review", exact: true }).click();
  await page.waitForFunction(
    () => document.activeElement?.id === "review-heading",
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
  await page.getByRole("tab", { name: "Review", exact: true }).click();
  await page.waitForFunction(() => document.activeElement?.id === "review-panel");
  await capture("web-review-mobile.png");
  await context.setOffline(true);
  await page.waitForFunction(
    () =>
      document.querySelector(".pill")?.textContent === "Not connected",
  );
  assert.equal(
    await page.getByRole("button", { name: /^Approve (?:\d+ files?|\d+ commands?)/ }).isEnabled(),
    false,
  );
  assert.equal(
    await page.getByRole("button", { name: "Reject", exact: true }).isEnabled(),
    false,
  );
  await capture("web-disconnected-review-mobile.png");
  await context.setOffline(false);
  await reconnectState();
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.getByLabel("Approval review", { exact: true }).waitFor();
  const decisionsBefore = commands.filter((c) => c === "decide").length;
  fault = { action: "decide", mode: "lost" };
  await viewReviewFiles();
  await page.getByRole("button", { name: /^Approve (?:\d+ files?|\d+ commands?)/ }).click();
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
  await openProject("beacon");
  await page
    .getByLabel("Task prompt")
    .waitFor();
  await page.getByRole("button", { name: "New session", exact: true }).click();
  await page.waitForFunction(
    () => document.querySelector(".pill")?.textContent === "Ready",
  );
  assert.equal(await page.getByLabel("Task prompt").inputValue(), "");
  await page.getByLabel("Task prompt").fill("draft for beacon");
  await createSession();
  await openSessions();
  await page.locator(".session-row").last().click();
  await page.waitForFunction(
    () => document.querySelector(".pill")?.textContent === "Ready",
  );
  assert.equal(
    await page.getByLabel("Task prompt").inputValue(),
    "draft for beacon",
  );
  await openProject("atlas");
  await page.waitForFunction(() => document.querySelector(".pill")?.textContent === "Done");
  assert.equal(await page.getByLabel("Task prompt").inputValue(), "draft for atlas");
  steps.push("in-memory drafts stay scoped to the selected session and workspace");
  const picker = page.getByLabel("Provider and model");
  await picker.click();
  await page.getByRole("switch", { name: "Configured only" }).click();
  await page.waitForFunction(() => document.querySelectorAll('[role="option"]').length === 3);
  assert.equal(await page.getByRole("option", { name: /Fixture missing/ }).getAttribute("aria-disabled"), "true");
  await page.getByLabel("Search models").fill("zzzz-not-a-model");
  await page.getByRole("button", { name: "Clear search", exact: true }).click();
  await page.keyboard.press("Escape");
  const originalModel = await page.locator("#model-choice").getAttribute("data-value");
  assert.equal(await page.getByLabel("Task prompt").inputValue(), "draft for atlas");
  await applyModel("Fixture next");
  await page.waitForFunction(() => document.querySelector("#model-choice")?.dataset.value === "anthropic/fixture-next" && !document.querySelector("#model-choice")?.disabled);
  await page.reload();
  await page.waitForFunction(() => document.querySelector("#model-choice")?.dataset.value === "anthropic/fixture-next" && !document.querySelector("#model-choice")?.disabled);
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
  await page.getByLabel("Approval review", { exact: true }).waitFor();
  await page.getByRole("button", {name:"Reject", exact:true}).click();
  await page.waitForFunction(() => ["Done", "Error", "Cancelled", "Refresh needed"].includes(document.querySelector(".pill")?.textContent ?? ""));
  await page.waitForFunction(() => {
    const pill = document.querySelector(".pill")?.textContent;
    const model = document.querySelector("#model-choice");
    if (model && !model.disabled && pill !== "Refresh needed" && pill !== "Not connected" && pill !== "Loading…") return true;
    for (const button of document.querySelectorAll("button")) if (button.textContent === "Reconnect") button.click();
    return false;
  }, null, { timeout: 15000, polling: 400 });
  await applyModel("Fixture current");
  await page.waitForFunction(value => document.querySelector("#model-choice")?.dataset.value === value && !document.querySelector("#model-choice")?.disabled, originalModel);

  // Another paired tab has active work while this tab sees an idle session.
  // The real host rejects the switch before replacing its owner.
  const background = await context.newPage();
  await background.addInitScript(csrf => {
    if (csrf) globalThis.sessionStorage.setItem("zhivex-web-csrf", csrf);
  }, await page.evaluate(() => globalThis.sessionStorage.getItem("zhivex-web-csrf")));
  await background.goto(ready.origin);
  await openSessions(background);
  await background.locator('.session-row').filter({hasText:"wait-for-cancel: preserve this draft"}).click();
  await background.waitForFunction(() => document.querySelector(".pill")?.textContent === "Cancelled");
  await background.getByLabel("Task prompt").fill("wait-for-cancel: background active run");
  await background.getByRole("button", {name:"Run task", exact:false}).click();
  await background.waitForFunction(() => document.querySelector(".pill")?.textContent === "Running");
  const busyResponse = page.waitForResponse(response => {
    if (!response.url().endsWith("/api/action")) return false;
    let body = null;
    try { body = response.request().postDataJSON(); } catch { return false; }
    return body?.action === "selectModel";
  });
  await applyModel("Fixture next");
  const busyBody = await (await busyResponse).json();
  assert.equal(busyBody.error?.code, "WEB_MODEL_CHANGE_BUSY", JSON.stringify(busyBody));
  await page.getByRole("alert").filter({hasText:/Model unchanged/}).waitFor();
  assert.equal(await picker.isEnabled(), true);
  assert.equal(await page.locator('.session-row:disabled').count(), 0);
  assert.notEqual(await page.locator('.pill').textContent(), "Refresh needed");
  await capture("web-model-rejected-desktop.png");
  await openSessions();
  await page.locator('.session-row').filter({hasText:"wait-for-cancel: preserve this draft"}).click();
  await page.waitForFunction(() => document.querySelector(".pill")?.textContent === "Running");
  assert.equal(await page.getByRole("button", {name:"Cancel run",exact:true}).isEnabled(), true);
  const modelRejectCancels = commands.filter(c => c === "cancel").length;
  await page.getByRole("button", {name:"Cancel run",exact:true}).click();
  await page.waitForFunction(() => document.querySelector(".pill")?.textContent === "Cancelled");
  assert.equal(commands.filter(c => c === "cancel").length, modelRejectCancels + 1);
  await background.close();
  steps.push("real cross-session busy model rejection preserves navigation and cancellation without reconnect or owner change");

  fault = {action:"selectModel",mode:"rejected",code:"WEB_MODEL_NOT_CONFIGURED"};
  await applyOtherModel(originalModel);
  await page.getByRole("alert").filter({hasText:/no longer configured/}).waitFor();
  assert.equal(await picker.isEnabled(), true);
  assert.equal(await page.locator('.session-row:disabled').count(), 0);
  await openSessions();
  assert.equal(await page.getByRole("button", { name: "Open project beacon", exact: true }).isEnabled(), true);
  await closeSessions();
  await createSession();
  steps.push("definitive unconfigured model rejection keeps workspace/session actions available");

  const switchesBeforeLoss = commands.filter(c => c === "selectModel").length;
  fault = {action:"selectModel",mode:"lost"};
  const lostModel = await applyOtherModel(originalModel);
  await page.getByRole("alert").getByText("WEB REQUEST FAILED", {exact:true}).waitFor();
  assert.equal(await picker.isDisabled(), true);
  assert(await page.locator('.session-row:disabled').count() > 0);
  await capture("web-model-uncertain-desktop.png");
  await reconnectState();
  await page.waitForFunction(value => document.querySelector("#model-choice")?.dataset.value === value && !document.querySelector("#model-choice")?.disabled, lostModel);
  assert.equal(commands.filter(c => c === "selectModel").length, switchesBeforeLoss + 1);
  steps.push("lost admitted model-switch response requires reconciliation and confirms the new host model without replay");

  // A matching code from the later context read is not a model rejection.
  // Leave the fault in place until that alert shows; the 2s context poll must not consume it.
  await page.route("**/api/context", async route => {
    await route.fulfill({status:400,json:{ok:false,error:{code:"WEB_MODEL_CHANGE_BUSY"}}});
  });
  const switchesBeforeContext = commands.filter(c => c === "selectModel").length;
  const contextModel = await applyOtherModel(originalModel);
  await page.getByRole("alert").getByText("WEB MODEL CHANGE BUSY", {exact:true}).waitFor();
  await page.unroute("**/api/context");
  await page.waitForFunction(() => document.querySelector('.pill')?.textContent === "Refresh needed");
  assert.equal(await picker.isDisabled(), true);
  await reconnectState();
  await page.waitForFunction(value => document.querySelector("#model-choice")?.dataset.value === value && !document.querySelector("#model-choice")?.disabled, contextModel);
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
  console.error(error);
  throw error;
} finally {
  await browser.close();
  const stopped = new Promise((resolve) => child.once("exit", resolve));
  child.send("close");
  await stopped;
}
