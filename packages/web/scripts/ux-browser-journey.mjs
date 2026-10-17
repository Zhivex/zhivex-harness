import assert from "node:assert/strict";
import { mkdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const evidenceDirectory = process.env.WEB_EVIDENCE_DIRECTORY ?? fileURLToPath(new URL("../.test-output/", import.meta.url));

async function captureTheme(page, theme) {
  await mkdir(evidenceDirectory, { recursive: true });
  await page.screenshot({ path: path.join(evidenceDirectory, `workspace-${theme}.png`) });
  await page.getByRole("button", { name: "Provider and model" }).click();
  await page.getByRole("option", { name: /Fixture next/ }).waitFor();
  await page.screenshot({ path: path.join(evidenceDirectory, `picker-${theme}-configured.png`) });
  await page.getByRole("checkbox", { name: "Configured only" }).uncheck();
  await page.getByText("1 provider without credentials").click();
  await page.getByRole("option", { name: /Fixture missing/ }).waitFor();
  await page.screenshot({ path: path.join(evidenceDirectory, `picker-${theme}-unconfigured.png`) });
  await page.keyboard.press("Escape");
}

/** Offline browser checks for theme, drawer, model search, diff position and shortcuts. */
async function assertWorkspaceContrast(page, theme) {
  const samples = await page.evaluate(() => {
    const channel = value => (value <= 0.03928 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4);
    const luminance = color => {
      const parts = color.match(/[\d.]+/g).map(Number);
      return 0.2126 * channel(parts[0] / 255) + 0.7152 * channel(parts[1] / 255) + 0.0722 * channel(parts[2] / 255);
    };
    const ratio = (foreground, background) => {
      const lighter = Math.max(luminance(foreground), luminance(background));
      const darker = Math.min(luminance(foreground), luminance(background));
      return (lighter + 0.05) / (darker + 0.05);
    };
    const paint = element => {
      let node = element;
      while (node) {
        const background = globalThis.getComputedStyle(node).backgroundColor;
        const parts = background.match(/[\d.]+/g);
        if (parts && (parts.length < 4 || Number(parts[3]) > 0.2)) return background;
        node = node.parentElement;
      }
      return "rgb(255, 255, 255)";
    };
    return [".topbar .subtle", ".icon-button", "h2", ".starter-list button", ".review-toolbar h2", ".eyebrow"].map(selector => {
      const element = document.querySelector(selector);
      if (!element) return { selector, missing: true };
      const style = globalThis.getComputedStyle(element);
      const foreground = style.color;
      const background = paint(element);
      return {
        selector,
        ratio: ratio(foreground, background),
        border: ratio(style.borderTopColor, background),
      };
    });
  });
  for (const sample of samples) {
    assert.equal(sample.missing, undefined, `${theme} ${sample.selector} missing`);
    assert.ok(sample.ratio >= 4.5, `${theme} ${sample.selector} text contrast ${sample.ratio}`);
    if (theme === "light" && (sample.selector === ".topbar .subtle" || sample.selector === ".starter-list button")) {
      assert.ok(sample.border >= 3, `${theme} ${sample.selector} border contrast ${sample.border}`);
    }
  }
}

export async function uxBrowserJourney(context, origin, csrf) {
  const page = await context.newPage();
  await page.addInitScript(value => {
    if (value) globalThis.sessionStorage.setItem("zhivex-web-csrf", value);
  }, csrf);
  const decisions = [];
  page.on("request", request => {
    if (request.url().endsWith("/api/action") && request.postDataJSON()?.action === "decide")
      decisions.push(request.postDataJSON().action);
  });
  try {
    await page.setViewportSize({ width: 1440, height: 1000 });
    await page.goto(origin);
    await page.getByRole("button", { name: "Sessions", exact: true }).waitFor();
    await page.getByRole("button", { name: "Theme system. Switch theme" }).click();
    await page.waitForFunction(() => globalThis.localStorage.getItem("zhivex.code.theme.v1") === "light");
    assert.equal(await page.locator(".app-shell").getAttribute("data-theme"), "light");
    await assertWorkspaceContrast(page, "light");
    await captureTheme(page, "light");
    await page.getByRole("button", { name: "Theme light. Switch theme" }).click();
    await page.waitForFunction(() => document.querySelector(".app-shell")?.getAttribute("data-theme") === "dark");
    await page.reload();
    await page.getByRole("button", { name: "Theme dark. Switch theme" }).waitFor();
    assert.equal(await page.locator(".app-shell").getAttribute("data-theme"), "dark");
    await assertWorkspaceContrast(page, "dark");
    await captureTheme(page, "dark");
    await page.getByRole("button", { name: "Theme dark. Switch theme" }).click();

    await page.getByRole("button", { name: "Sessions", exact: true }).click();
    await page.getByRole("button", { name: "Open project atlas", exact: true }).waitFor();
    await page.getByRole("button", { name: "Open project beacon", exact: true }).waitFor();
    await page.getByLabel("Search sessions").fill("no-such-session");
    await page.getByText("No sessions match your search.", { exact: true }).waitFor();
    await page.getByLabel("Search sessions").fill("");
    await page.getByRole("button", { name: "Add project", exact: true }).click();
    await page.getByRole("heading", { name: "Add a project from the terminal" }).waitFor();
    assert.equal(await page.locator('input[type="file"], input[webkitdirectory]').count(), 0);
    await page.getByRole("dialog", { name: "Add a project from the terminal" }).getByRole("button", { name: "Close", exact: true }).click();
    await page.keyboard.press("Escape");

    await page.getByRole("button", { name: "Provider and model" }).click();
    const configuredOnly = page.getByRole("checkbox", { name: "Configured only" });
    assert.equal(await configuredOnly.isChecked(), true);
    await page.waitForFunction(() => document.querySelectorAll('[role="option"]').length === 2);
    assert.equal(await page.getByRole("option", { name: /Fixture missing/ }).count(), 0);
    await page.getByRole("option", { name: /Fixture next/ }).waitFor();
    const row = page.locator(".model-option").first();
    const box = await row.boundingBox();
    assert.ok(box && box.height >= 36 && box.height <= 44);
    assert.equal(await row.evaluate(element => globalThis.getComputedStyle(element).outlineStyle), "none");
    await page.getByLabel("Search models").fill("zzzz-not-a-model");
    await page.getByRole("button", { name: "Clear search", exact: true }).click();
    await configuredOnly.uncheck();
    await page.getByText("1 provider without credentials").click();
    await page.getByRole("option", { name: /Fixture missing/ }).waitFor();
    assert.equal(await page.getByRole("option", { name: /Fixture missing/ }).getAttribute("aria-disabled"), "true");
    assert.equal(await page.getByText("Configure credentials in the CLI.", { exact: true }).count(), 1);
    await page.keyboard.press("Escape");

    await page.locator("body").press("Alt+Shift+A");
    assert.deepEqual(decisions, []);
    await page.locator("body").press("Alt+Shift+J");
    await page.getByLabel("Search sessions").waitFor();
    await page.keyboard.press("Escape");

    await page.getByRole("radio", { name: "Side", exact: true }).click();
    await page.setViewportSize({ width: 900, height: 800 });
    await page.getByText("Side by side does not fit this window.", { exact: false }).waitFor();
    assert.equal(await page.getByRole("radio", { name: "Side", exact: true }).isDisabled(), true);
    assert.equal(await page.evaluate(() => JSON.parse(globalThis.localStorage.getItem("zhivex.code.diffLayout.v1")).position), "side");
    assert.equal(await page.locator(".workspace-frame").getAttribute("data-position"), "bottom");
    await page.setViewportSize({ width: 1440, height: 1000 });
    await page.getByRole("radio", { name: "Fullscreen", exact: true }).click();
    await page.waitForFunction(() => document.querySelector(".workspace-frame")?.getAttribute("data-position") === "full");
    await page.keyboard.press("Escape");
    await page.waitForFunction(() => document.querySelector(".workspace-frame")?.getAttribute("data-position") !== "full");
    await page.evaluate(() => {
      globalThis.localStorage.removeItem("zhivex.code.theme.v1");
      globalThis.localStorage.removeItem("zhivex.code.diffLayout.v1");
      globalThis.localStorage.removeItem("zhivex.code.modelPicker.v1");
      globalThis.localStorage.removeItem("zhivex.code.drawer.v1");
    });
  } finally {
    await page.close();
  }
}
