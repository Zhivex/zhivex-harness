import {
  fillRendererFixture,
  selectRendererFixture,
} from "./renderer-fixture-data.js";
import assert from "node:assert/strict";
import type { BrowserWindow } from "electron";
import { writeFile } from "node:fs/promises";
import path from "node:path";

/** Product interactions against the real renderer and isolated fixture runtime. */
export async function verifyDesktopUX(window: BrowserWindow, report: string) {
  const js = (code: string) => window.webContents.executeJavaScript(code);
  const wait = async (code: string) => {
    for (let i = 0; i < 200; i++) {
      if (await js(code)) return;
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    throw new Error(`UX_TIMEOUT: ${code}`);
  };
  const click = (selector: string) =>
    js(`document.querySelector(${JSON.stringify(selector)}).click()`);
  const fill = (selector: string, value: string) =>
    fillRendererFixture(window, selector, value);
  const capture = async (name: string) => {
    await js(
      "document.fonts.ready.then(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve(true)))))",
    );
    await writeFile(
      path.join(report, `${name}.png`),
      (await window.webContents.capturePage()).toPNG(),
    );
  };
  window.setSize(1120, 760);
  await wait("document.querySelectorAll('.suggestion').length===3");
  await js(
    "Promise.all([document.fonts.load('400 14px \"Inter Variable\"'),document.fonts.load('500 30px \"Space Grotesk Variable\"')]).then(() => true)",
  );
  assert(
    await js(
      "document.fonts.check('400 14px \"Inter Variable\"') && document.fonts.check('500 30px \"Space Grotesk Variable\"')",
    ),
  );
  await capture("welcome-1120");
  await click(".suggestion");
  await wait(
    "document.querySelector('#prompt').value.startsWith('Explore') && document.activeElement.id==='prompt'",
  );
  assert.equal(await js("document.querySelectorAll('[data-run]').length"), 0);
  await fill('[aria-label="Search conversations"]', "no-existent-conversation");
  await wait(
    "document.querySelectorAll('[data-session]').length===0 && document.body.innerText.includes('No conversations found')",
  );
  await fill('[aria-label="Search conversations"]', "");
  await wait("document.querySelectorAll('[data-session]').length===1");
  await click(".sidebar-toggle");
  await wait(
    "document.querySelector('aside').hidden && document.querySelector('.sidebar-toggle').getAttribute('aria-expanded')==='false'",
  );
  await click(".sidebar-toggle");
  await wait("!document.querySelector('aside').hidden");
  await click("[data-action=open-models]");
  await wait("document.querySelector('.model-dialog').open");
  await fill('[aria-label="Search models"]', "qwen");
  await wait("document.querySelectorAll('.model-card').length>1 && [...document.querySelectorAll('.model-card-provider')].every(el=>el.textContent.includes('Qwen'))");
  await click(".model-card");
  await wait("Boolean(document.querySelector('[data-action=apply-model]'))");
  await capture("model-search");
  window.focus();
  window.webContents.focus();
  window.webContents.sendInputEvent({ type: "keyDown", keyCode: "Escape" });
  window.webContents.sendInputEvent({ type: "keyUp", keyCode: "Escape" });
  await wait(
    "!document.querySelector('.model-dialog').open && !document.querySelector('[data-action=start]').disabled",
  );
  assert.equal(
    await js("document.querySelector('[data-action=select-provider]').value"),
    "openai",
  );
  assert(await js("document.activeElement.dataset.action==='open-models'"));
  await click("[data-action=open-models]");
  await wait(
    "document.querySelector('.model-dialog').open && document.querySelectorAll('.model-card').length>4 && document.querySelector('.model-others') && !document.querySelector('.model-others').open",
  );
  await capture("models-1120");
  window.setSize(720, 520);
  await wait("innerWidth===720");
  await click(".model-card");
  await wait("Boolean(document.querySelector('[data-action=apply-model]'))");
  assert(
    await js(
      "(()=>{const r=document.querySelector('[data-action=apply-model]').getBoundingClientRect();return r.top>=0 && r.bottom<=innerHeight})()",
    ),
  );
  await capture("models-720");
  await click('[aria-label="Close model selector"]');
  const geometry = await js(
    "(()=>{const c=document.querySelector('.chat-composer').getBoundingClientRect(),s=document.querySelector('[data-action=start]').getBoundingClientRect();return {width:innerWidth,height:innerHeight,composerVisible:c.bottom<=innerHeight,sendVisible:s.right<=innerWidth,noHorizontalOverflow:document.documentElement.scrollWidth<=innerWidth}})()",
  );
  assert(
    geometry.composerVisible &&
      geometry.sendVisible &&
      geometry.noHorizontalOverflow,
  );
  await capture("welcome-720");
  await click(".sidebar-toggle");
  await capture("collapsed-720");
  await click(".sidebar-toggle");
  window.setSize(1120, 760);
  await fill("#prompt", "Describe the local runtime connection.");
  // Neither Shift+Enter nor composition confirmation should submit a message.
  await js(
    "document.querySelector('#prompt').dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',shiftKey:true,bubbles:true,cancelable:true}));document.querySelector('#prompt').dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',isComposing:true,bubbles:true,cancelable:true}))",
  );
  assert.equal(await js("document.querySelectorAll('[data-run]').length"), 0);
  await js("document.querySelector('#prompt').focus()");
  window.webContents.sendInputEvent({ type: "keyDown", keyCode: "Return" });
  window.webContents.sendInputEvent({ type: "keyUp", keyCode: "Return" });
  await wait(
    "document.querySelectorAll('[data-run]').length===1 && document.body.innerText.includes('completed') && document.querySelector('#prompt').value===''",
  );
  // Preserve drafts during refresh, navigation and renderer restart.
  const original = await js("document.querySelector('main').dataset.sessionId");
  await fill("#prompt", "Draft retained across navigation");
  await click('[aria-label="Refresh conversation"]');
  await wait(
    "document.querySelector('#prompt').value==='Draft retained across navigation' && !document.querySelector('#prompt').disabled",
  );
  await click('[data-action="new-session"]');
  await wait(
    `document.querySelector('main').dataset.sessionId && document.querySelector('main').dataset.sessionId!==${JSON.stringify(original)} && !document.querySelector('#prompt').disabled`,
  );
  assert.equal(await js("document.querySelector('#prompt').value"), "");
  await fill("#prompt", "Second independent draft");
  await click(`[data-session="${original}"]`);
  await wait(
    "document.querySelector('#prompt').value==='Draft retained across navigation'",
  );
  const loaded = new Promise<void>((resolve) =>
    window.webContents.once("did-finish-load", () => resolve()),
  );
  window.webContents.reload();
  await loaded;
  await wait("document.querySelector('[data-session]')?.disabled===false");
  await click(`[data-session="${original}"]`);
  await wait(
    "document.querySelector('#prompt').value==='Draft retained across navigation'",
  );
  await js(
    `document.querySelector('[data-session="${original}"]').parentElement.querySelector('details').open=true`,
  );
  await js(
    `document.querySelector('[data-session="${original}"]').parentElement.querySelector('.session-actions button').click()`,
  );
  await fill(
    '[aria-label="Conversation title"]',
    "Renamed desktop conversation",
  );
  await js("document.querySelector('.rename-form').requestSubmit()");
  await wait(
    "document.querySelector('h1').textContent==='Renamed desktop conversation'",
  );
  await js(
    `document.querySelector('[data-session="${original}"]').parentElement.querySelector('.session-actions button:last-child').click()`,
  );
  await wait(`!document.querySelector('[data-session="${original}"]')`);
  await selectRendererFixture(
    window,
    '[aria-label="Filter conversations"]',
    "archived",
  );
  await wait(`Boolean(document.querySelector('[data-session="${original}"]'))`);
  await js(
    `document.querySelector('[data-session="${original}"]').parentElement.querySelector('.session-actions button:last-child').click()`,
  );
  await selectRendererFixture(
    window,
    '[aria-label="Filter conversations"]',
    "all",
  );
  await wait(`Boolean(document.querySelector('[data-session="${original}"]'))`);
  await click('[data-action="open-credentials"]');
  await wait("document.querySelector('.credential-dialog').open");
  await capture("credentials-dialog");
  await click('[aria-label="Close credentials"]');
  await wait("!document.querySelector('.credential-dialog').open");
  await fill("#prompt", "");
  return {
    draftsAcrossRefreshAndReload: true,
    isolatedDrafts: true,
    renameConversation: true,
    archiveRestore: true,
    credentialDialog: true,
    suggestionsOnlyFill: true,
    searchConversations: true,
    sidebarToggle: true,
    modelSearch: true,
    dismissRestoresModel: true,
    dialogFocusReturn: true,
    enterSends: true,
    shiftEnterAndIMEProtected: true,
    bundledFonts: true,
    compactLayout: geometry,
  };
}
