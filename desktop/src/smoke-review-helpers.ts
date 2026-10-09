import assert from "node:assert/strict";
import type { BrowserWindow } from "electron";

type Evaluate = (source: string) => Promise<any>;

export async function viewReviewFiles(js: Evaluate, wait: (source: string) => Promise<void>) {
  await wait('document.querySelector("[data-action=approve-review]") !== null');
  await js('document.querySelectorAll("[data-action=view-file]").forEach(input => { if (!input.checked) input.click(); })');
}

export async function assertReviewEnterDoesNotDecide(window: BrowserWindow, js: Evaluate) {
  // Count native decision-button clicks as well as inspecting the still-open review.
  await js(`window.__reviewDecisionAttempts = 0;
    document.querySelectorAll('[data-action="approve-review"], [data-action="deny-review"]').forEach(button => {
      button.addEventListener('click', () => window.__reviewDecisionAttempts++, { once: true });
    });`);
  const selectors = ['[data-action="approve-review"]', '[data-action="deny-review"]', '[data-action="view-file"]', '.review-panel summary', '.review-panel [role="region"]'];
  window.focus();
  window.webContents.focus();
  for (const selector of selectors) {
    if (!await js(`Boolean(document.querySelector(${JSON.stringify(selector)}) && !document.querySelector(${JSON.stringify(selector)}).disabled)`)) continue;
    await js(`document.querySelector(${JSON.stringify(selector)}).focus()`);
    for (const modifiers of [[], ["control"], ["meta"]] as Array<Array<"control" | "meta">>) {
      window.webContents.sendInputEvent({ type: "keyDown", keyCode: "Return", modifiers });
      window.webContents.sendInputEvent({ type: "char", keyCode: "\r", modifiers });
      window.webContents.sendInputEvent({ type: "keyUp", keyCode: "Return", modifiers });
    }
  }
  assert.equal(await js('window.__reviewDecisionAttempts'), 0);
  assert(await js('Boolean(document.querySelector("[data-action=approve-review]"))'));
}
