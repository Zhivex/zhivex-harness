import assert from "node:assert/strict";

/** Offline browser checks for theme, drawer, model search, diff position and shortcuts. */
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
    await page.getByRole("button", { name: "Theme light. Switch theme" }).click();
    await page.waitForFunction(() => document.querySelector(".app-shell")?.getAttribute("data-theme") === "dark");
    await page.reload();
    await page.getByRole("button", { name: "Theme dark. Switch theme" }).waitFor();
    assert.equal(await page.locator(".app-shell").getAttribute("data-theme"), "dark");
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
    await page.getByLabel("Search models").fill("zzzz-not-a-model");
    await page.getByRole("button", { name: "Clear search", exact: true }).click();
    await page.getByRole("option", { name: /Fixture missing/ }).waitFor();
    assert.equal(await page.getByRole("option", { name: /Fixture missing/ }).getAttribute("aria-disabled"), "true");
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
