import assert from "node:assert/strict";

export async function limitsJourney(page, capture, commands) {
  const launcher = () => page.getByRole("button", { name: /Sin límites configurados|Límites de próxima tarea|Límites de proyecto/ });
  const dialog = page.getByRole("dialog", { name: "Configura solo lo que necesites" });
  const open = async () => { await launcher().click(); await dialog.waitFor(); };
  const save = async () => { await dialog.getByRole("button", { name: "Guardar límites", exact: true }).click(); };
  const writes = () => commands.filter(c => c === "configureLimits").length;
  const initialWrites = writes();
  await open();
  assert.equal(await dialog.getByRole("button", { name: "Próxima tarea", exact: true }).getAttribute("aria-pressed"), "true");
  assert.equal(await dialog.getByRole("checkbox", { name: "Configurar un umbral", exact: true }).isChecked(), false);
  assert.equal(await dialog.getByLabel("Importe en USD", { exact: true }).isDisabled(), true);
  await page.setViewportSize({ width: 1487, height: 1058 });
  await capture("web-limits-desktop-dark.png");
  await save(); await dialog.waitFor({ state: "hidden" }); assert.equal(writes(), initialWrites);
  assert.equal(await launcher().evaluate(node => node === document.activeElement), true);
  await open(); await page.keyboard.press("Escape"); await dialog.waitFor({ state: "hidden" });
  assert.equal(writes(), initialWrites);
  await open(); await dialog.getByRole("checkbox", { name: "Configurar un umbral", exact: true }).check();
  await dialog.getByLabel("Importe en USD", { exact: true }).fill("5,00");
  await dialog.getByRole("button", { name: "Cancelar", exact: true }).click();
  await dialog.waitFor({ state: "hidden" }); assert.equal(writes(), initialWrites);
  await open(); await dialog.getByRole("button", { name: "Proyecto", exact: true }).click();
  await dialog.getByRole("button", { name: /^Tokens/ }).click();
  const tokenToggle = () => dialog.getByRole("checkbox", { name: "Configurar un umbral", exact: true }).filter({ visible: true });
  await tokenToggle().focus(); await page.keyboard.press("Space");
  await dialog.getByLabel("Tokens totales", { exact: true }).fill("1.5"); await save();
  await dialog.getByRole("alert").waitFor(); assert.equal(writes(), initialWrites);
  assert.equal(await dialog.getByLabel("Tokens totales", { exact: true }).getAttribute("aria-invalid"), "true");
  await dialog.getByLabel("Tokens totales", { exact: true }).fill("20"); await save();
  await dialog.waitFor({ state: "hidden" }); assert.equal(writes(), initialWrites + 1);
  await page.reload(); await launcher().waitFor(); await open();
  await dialog.getByRole("button", { name: "Proyecto", exact: true }).click();
  await dialog.getByRole("button", { name: /^Tokens/ }).click();
  assert.equal(await dialog.getByLabel("Tokens totales", { exact: true }).inputValue(), "20");
  await dialog.getByRole("button", { name: /^Pasos y herramientas/ }).click();
  for (const [toggle, label, value] of [["Configurar un umbral de pasos", "Pasos", "3"], ["Configurar un umbral de herramientas", "Llamadas a herramientas", "4"]]) {
    const control = dialog.getByRole("checkbox", { name: toggle, exact: true });
    assert.equal(await control.isChecked(), false); await control.check();
    await dialog.getByLabel(label, { exact: true }).fill(value);
  }
  await capture("web-limits-controls-desktop.png");
  await page.setViewportSize({ width: 390, height: 844 }); await capture("web-limits-mobile-dark.png", false);
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
  assert.equal(await dialog.evaluate(node => node.scrollWidth <= node.clientWidth), true);
  for (let i = 0; i < 24; i++) { await page.keyboard.press("Tab");
    assert.equal(await dialog.evaluate(node => node.contains(document.activeElement)), true); }
  await dialog.getByRole("button", { name: "Guardar límites", exact: true }).scrollIntoViewIfNeeded();
  await capture("web-limits-mobile-footer.png", false);
  await dialog.getByRole("button", { name: "Cancelar", exact: true }).click();
  await page.setViewportSize({ width: 1440, height: 1000 }); await open();
  await dialog.getByRole("button", { name: "Proyecto", exact: true }).click();
  await dialog.getByRole("button", { name: /^Tokens/ }).click(); await tokenToggle().uncheck();
  await save(); await dialog.waitFor({ state: "hidden" });
}
