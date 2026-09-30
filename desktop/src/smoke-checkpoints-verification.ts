import { app, type BrowserWindow } from 'electron';
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';
import type { ProjectRuntime } from './runtime-host.js';
import { openCliSessionStore, openWorkspaceCheckpointStore, Workspace, resolveHarnessConfig } from '@zhivex-ai/harness/engine';

export async function verifyDesktopCheckpoints(window: BrowserWindow, runtimes: Map<string, Promise<ProjectRuntime>>, directory: string, phase: string) {
  const js = async (source: string) => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try { return await Promise.race([window.webContents.executeJavaScript(source), new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error('CHECKPOINT_RENDERER_TIMEOUT')), 10000);
    })]); } catch (error) {
      await writeFile(path.join(directory, `${phase}-failure-script.txt`), source);
      throw error;
    } finally { clearTimeout(timer); }
  };
  const wait = async (source: string) => {
    for (let i = 0; i < 200; i++) { if (await js(source)) return; await new Promise(resolve => setTimeout(resolve, 50)); }
    await writeFile(path.join(directory, `${phase}-failure-view.txt`), await js('document.body.innerText')); throw new Error(`CHECKPOINT_UI_TIMEOUT: ${source}`);
  };
  const click = (selector: string) => js(`document.querySelector(${JSON.stringify(selector)}).click()`);
  const button = async (label: string) => {
    const query = `Array.from(document.querySelectorAll('[data-action=checkpoints] button')).find(b=>b.textContent===${JSON.stringify(label)})`;
    await wait(`${query}?.disabled === false`); await js(`${query}.click()`);
  };
  const file = path.join(directory, 'checkpoint-state.json');
  await wait('document.querySelector("[data-ready=true]") !== null');
  if (phase !== 'prepare') { await wait('document.querySelector("[data-project]") !== null'); await click('[data-project]'); }
  await wait('document.querySelector("[data-action=new-session]")?.disabled === false');
  const key = await js('document.querySelector("main").dataset.projectKey');
  const runtime = await runtimes.get(key)!;
  const target = path.join(runtime.context.project.workspace, 'review.txt');
  let saved: { source: string; operationId: string; ticketId: string; derivative?: string; existingFork?: string };
  if (phase === 'prepare') {
    await click('[data-action=new-session]'); await wait('Boolean(document.querySelector("main").dataset.sessionId)');
    await js(`const field=document.querySelector('#prompt');Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype,'value').set.call(field,'Describe the local runtime connection.');field.dispatchEvent(new Event('input',{bubbles:true}));`);
    await wait('document.querySelector("[data-action=start]")?.disabled === false'); await click('[data-action=start]');
    await wait('document.body.innerText.includes("Status: completed")');
    const source = await js('document.querySelector("main").dataset.sessionId');
    await button('Workspace checkpoints');
    await wait('document.querySelector("[data-action=checkpoints] textarea") !== null');
    await js(`(()=>{document.querySelector('[data-action=checkpoints] details').open=true; const field=document.querySelector('[data-action=checkpoints] textarea');Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype,'value').set.call(field,'review.txt');field.dispatchEvent(new Event('input',{bubbles:true}));})()`);
    await button('Capture selected files');
    await wait('document.querySelector("[data-action=checkpoints]").innerText.includes("review.txt")');
    await writeFile(target, 'changed after checkpoint\n');
    await button('Prepare restore review');
    await wait(`document.querySelector('[aria-label="Review checkpoint restoration"]') !== null`);
    assert.equal(await readFile(target, 'utf8'), 'changed after checkpoint\n');
    const listed = await runtime.command({ method: 'checkpoint.list', sessionId: source });
    assert(listed.ok && listed.data.kind === 'checkpoints'); assert.equal(listed.data.restores.length, 1);
    const operationId = listed.data.restores[0]!.id;
    const old = await runtime.reviewCheckpoint(source, operationId);
    saved = { source, operationId, ticketId: old.ticketId };
    if (process.argv.includes('--fixture-checkpoint-interrupted')) {
      const config = resolveHarnessConfig({ workspace: runtime.context.project.workspace, stateDirectory: runtime.stateDirectory });
      const sessions = await openCliSessionStore({ workspace: config.workspace, stateDirectory: config.stateDirectory, scope: config.scope });
      const checkpoints = await openWorkspaceCheckpointStore(await Workspace.open(config.workspace), sessions);
      try {
        const original = sessions.fork.bind(sessions);
        sessions.fork = async (...args) => { const fork = await original(...args); saved.existingFork = fork.sessionId; throw new Error('FIXTURE_AFTER_FORK'); };
        await assert.rejects(checkpoints.applyRestore(operationId, old.operation.proposalId), /FIXTURE_AFTER_FORK/);
        assert.equal(checkpoints.getOperation(operationId).stage, 'forking');
        assert(saved.existingFork); assert.equal(await readFile(target, 'utf8'), 'changed after checkpoint\n');
      } finally { checkpoints.close(); sessions.close(); }
    }
    await writeFile(file, JSON.stringify(saved));
    const image = await window.webContents.capturePage(); await writeFile(path.join(directory, 'review.png'), image.toPNG());
  } else {
    saved = JSON.parse(await readFile(file, 'utf8'));
    await wait(`document.querySelector('[data-session="${saved.source}"]')?.disabled === false`); await click(`[data-session="${saved.source}"]`);
    await wait(`document.querySelector('main').dataset.sessionId === ${JSON.stringify(saved.source)} && document.querySelector('[data-action=checkpoints] button')?.disabled === false`);
    await button('Workspace checkpoints');
    if (phase === 'recover') {
      assert(saved.existingFork);
      await wait(`document.querySelector('[data-action=checkpoints] input:not([type=checkbox])') !== null`);
      await js(`(()=>{const field=document.querySelector('[data-action=checkpoints] input:not([type=checkbox])');Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(field,${JSON.stringify(saved.existingFork)});field.dispatchEvent(new Event('input',{bubbles:true}));})()`);
      await button('Review recovery');
      await wait(`document.querySelector('[aria-label="Review checkpoint restoration"] input[type=checkbox]') !== null`);
      assert.equal(await readFile(target, 'utf8'), 'changed after checkpoint\n');
      await click('[aria-label="Review checkpoint restoration"] input[type=checkbox]'); await button('Confirm recovery');
      await wait(`document.querySelector('[data-action=checkpoints]').innerText.includes('forked')`);
      assert.equal(await readFile(target, 'utf8'), 'changed after checkpoint\n');
    } else if (phase === 'apply') {
      await assert.rejects(runtime.resolveCheckpointReview(saved.ticketId, true), /REVIEW_REQUIRED/);
      const before = await runtime.command({ method: 'session.get', sessionId: saved.source });
      await button('Review saved operation');
      await wait(`document.querySelector('[aria-label="Review checkpoint restoration"] input[type=checkbox]') !== null`);
      assert.equal(await js(`Array.from(document.querySelectorAll('[data-action=checkpoints] button')).find(b=>b.textContent==='Confirm restoration').disabled`), true);
      await click('[aria-label="Review checkpoint restoration"] input[type=checkbox]'); await button('Confirm restoration');
      await wait(`Boolean(document.querySelector('main').dataset.sessionId) && document.querySelector('main').dataset.sessionId !== ${JSON.stringify(saved.source)}`);
      saved.derivative = await js('document.querySelector("main").dataset.sessionId');
      assert.equal(await readFile(target, 'utf8'), 'checkpoint original\n');
      const retained = await runtime.command({ method: 'session.get', sessionId: saved.source });
      assert(before.ok && retained.ok); assert.deepEqual(retained.data, before.data);
      await writeFile(file, JSON.stringify(saved));
    } else {
      await button('Open restored conversation');
      await wait(`document.querySelector('main').dataset.sessionId === ${JSON.stringify(saved.derivative)}`);
      const listed = await runtime.command({ method: 'session.list' }); assert(listed.ok && listed.data.kind === 'sessions');
      assert.equal(listed.data.sessions.filter(session => session.parentSessionId === saved.source).length, 1);
      assert.equal(await readFile(target, 'utf8'), 'checkpoint original\n');
    }
  }
  await writeFile(path.join(directory, `${phase}-report.json`), JSON.stringify({ phase, appPid: process.pid, runtimePid: runtime.context.runtimePid,
    source: saved.source, operationId: saved.operationId, derivative: saved.derivative, packaged: app.isPackaged, status: 'passed' }));
  app.quit();
}
