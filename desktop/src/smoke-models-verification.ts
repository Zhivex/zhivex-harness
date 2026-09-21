import { verifyDesktopUX } from "./smoke-ux-verification.js";
import { app, type BrowserWindow } from "electron";
import { writeFile } from "node:fs/promises";
import path from "node:path";
import assert from "node:assert/strict";
import type { ProjectRuntime } from "./runtime-host.js";

export async function verifyDesktopModelsSmoke(
  window: BrowserWindow,
  runtimes: Map<string, Promise<ProjectRuntime>>,
  report: string,
) {
  const js = (code: string) => window.webContents.executeJavaScript(code);
  const wait = async (code: string) => {
    for (let i = 0; i < 200; i++) {
      if (await js(code)) return;
      await new Promise((r) => setTimeout(r, 25));
    }
    await writeFile(
      path.join(report, "view.txt"),
      await js("document.body.innerText"),
    );
    throw new Error(`MODEL_UI_TIMEOUT: ${code}`);
  };
  const click = (selector: string) =>
    js(`document.querySelector(${JSON.stringify(selector)}).click()`);
  const select = (selector: string, value: string) =>
    js(
      `(()=>{const el=document.querySelector(${JSON.stringify(selector)});el.value=${JSON.stringify(value)};el.dispatchEvent(new Event('change',{bubbles:true}));})()`,
    );
  await wait(
    "document.querySelector('main[data-ready=true]')?.dataset.projectKey && document.querySelector('[data-action=select-provider] option[value=qwen]')",
  );
  const key = await js("document.querySelector('main').dataset.projectKey");
  const catalog = await js("window.harness.providers()");
  assert.deepEqual(catalog.map((p: { id: string }) => p.id).sort(), [
    "gemini",
    "meta",
    "openai",
    "qwen",
  ]);
  await click("[data-action=new-session]");
  await wait("Boolean(document.querySelector('main').dataset.sessionId)");
  const sessionId = await js(
    "document.querySelector('main').dataset.sessionId",
  );
  const ux = await verifyDesktopUX(window, report);
  const evidence = [];
  for (const provider of ["qwen", "meta", "gemini", "openai"]) {
    await click("[data-action=open-models]");
    await click(".model-advanced > summary");
    await select("[data-action=select-provider]", provider);
    await wait("Boolean(document.querySelector('[data-action=apply-model]'))");
    await click("[data-action=apply-model]");
    await wait(
      "!document.querySelector('[data-action=apply-model]') && !document.querySelector('[data-action=select-provider]').disabled",
    );
    const host = await runtimes.get(key)!;
    assert.equal(host.context.modelSelection?.provider, provider);
    const before = await host.command({ method: "session.get", sessionId });
    assert(before.ok && before.data.kind === "session");
    const result = await host.command({
      method: "run.start",
      sessionId,
      expectedRevision: before.data.session.revision,
      idempotencyKey: `models-${provider}`,
      prompt: "Describe the local runtime connection.",
    });
    assert(result.ok && result.data.kind === "run");
    assert.equal(result.data.session.runs.at(-1)?.provider, provider);
    assert.equal(
      result.data.session.runs.at(-1)?.model,
      catalog.find((p: { id: string }) => p.id === provider).defaultModel,
    );
    evidence.push({ provider, runtimeBinding: true, storedRunBinding: true });
  }
  // The editable choice really reaches the worker; it is not just a renderer label.
  await click("[data-action=open-models]");
  await click(".model-advanced > summary");
  await select("[data-action=select-model]", "__custom");
  await js(
    `(()=>{const el=document.querySelector('[aria-label="Model ID"]');Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(el,'fixture-custom-model');el.dispatchEvent(new Event('input',{bubbles:true}));})()`,
  );
  await wait("Boolean(document.querySelector('[data-action=apply-model]'))");
  await click("[data-action=apply-model]");
  await wait("!document.querySelector('[data-action=apply-model]')");
  let host = await runtimes.get(key)!;
  assert.equal(host.context.modelSelection?.model, "fixture-custom-model");
  const loaded = new Promise<void>((resolve) =>
    window.webContents.once("did-finish-load", () => resolve()),
  );
  window.webContents.reload();
  await loaded;
  await wait(
    "document.querySelector('main[data-ready=true]') && document.querySelector('[data-action=select-model]')?.value==='fixture-custom-model'",
  );
  // Changing a model cannot abandon another conversation's approval.
  const created = await host.command({
    method: "session.create",
    idempotencyKey: "approval-model",
  });
  assert(created.ok && created.data.kind === "session");
  const pending = await host.command({
    method: "run.start",
    sessionId: created.data.session.sessionId,
    expectedRevision: created.data.session.revision,
    idempotencyKey: "approval-run",
    prompt: "file-review-probe",
  });
  assert(pending.ok && pending.data.kind === "run");
  assert.equal(pending.data.run.status, "waiting_approval");
  assert(
    await js(
      `window.harness.selectModel(${JSON.stringify(key)},{provider:'qwen',model:'qwen3.8-max'}).then(()=>false,e=>e.message.includes('MODEL_WORK_ACTIVE'))`,
    ),
  );
  assert.equal(
    (await runtimes.get(key)!).context.modelSelection?.model,
    "fixture-custom-model",
  );
  assert(
    await js(
      `window.harness.selectModel(${JSON.stringify(key)},{provider:'deepseek',model:'invalid'}).then(()=>false,()=>true)`,
    ),
  );
  const refreshed = new Promise<void>((resolve) =>
    window.webContents.once("did-finish-load", () => resolve()),
  );
  window.webContents.reload();
  await refreshed;
  await wait(
    "document.querySelector('main[data-ready=true]') && document.querySelectorAll('[data-session]').length===2",
  );
  await click(`[data-session="${sessionId}"]`);
  await wait("document.body.innerText.includes('Separate runtime')");
  const rows = [];
  for (const [width, height] of [
    [1120, 760],
    [720, 520],
  ]) {
    window.setSize(width!, height!);
    await new Promise((r) => setTimeout(r, 100));
    rows.push(
      await js(
        `(()=>{const composer=document.querySelector('.chat-composer').getBoundingClientRect(),chat=document.querySelector('.conversation').getBoundingClientRect();return {width:innerWidth,height:innerHeight,composerVisible:composer.bottom<=innerHeight+1,chatHeight:chat.height,noHorizontalOverflow:document.documentElement.scrollWidth<=innerWidth};})()`,
      ),
    );
    await writeFile(
      path.join(report, `chat-${width}.png`),
      (await window.webContents.capturePage()).toPNG(),
    );
  }
  assert(
    rows.every(
      (r) => r.composerVisible && r.noHorizontalOverflow && r.chatHeight > 0,
    ),
  );
  // Return to the pending session to exercise the approval UI after the blocked switch.
  await click(`[data-session="${created.data.session.sessionId}"]`);
  await wait("Boolean(document.querySelector('[data-action=review]'))");
  await writeFile(
    path.join(report, "report.json"),
    JSON.stringify(
      {
        packaged: app.isPackaged,
        fixtureModel: true,
        providers: evidence,
        customModel: true,
        rendererReload: true,
        approvalBlocksSwitch: true,
        unsupportedProviderRejected: true,
        layout: rows,
        ux,
      },
      null,
      2,
    ),
  );
}
