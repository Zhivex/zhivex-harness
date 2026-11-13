/** Regression: settings shutdown must not claim a native host has already stopped. */
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
import { startManagedAssistant } from '../src/web/setup.js';
import { createDesktopLifecycle } from '../src/desktop-lifecycle.js';

const browser = await chromium.launch({ headless: true });
try {
  for (const native of [true, false]) {
    const directory = await mkdtemp('/tmp/desktop-settings-');
    let closed = false, stopRequests = 0;
    const lifecycle = await createDesktopLifecycle({ directory,
      native: { async request() { return {}; } },
      async control() { return false; }, async work() { return []; },
      async close() { closed = true; },
    });
    const app = await startManagedAssistant(directory + '/state', {
      assetsDirectory: process.argv[2] ?? fileURLToPath(new URL('../web/dist', import.meta.url)),
      secrets: { async read() { return null; }, async write() {} },
      ...(native ? { lifecycle } : {}),
      onStop() { stopRequests++; if (native) lifecycle.requestQuit(); },
    });
    const page = await browser.newPage(); const errors: string[] = [];
    page.on('pageerror', error => errors.push(error.message));
    try {
      await page.goto(app.url);
      await page.getByRole('button', { name: 'Apagar Assistant', exact: true }).click();
      if (native) {
        const dialog = page.getByRole('dialog', { name: 'Salir de Assistant' });
        await dialog.waitFor();
        assert.equal(await page.getByRole('heading', { name: 'Assistant está apagado' }).count(), 0);
        assert.equal(closed, false);
        await page.getByRole('button', { name: 'Volver a la app', exact: true }).click();
        await dialog.waitFor({ state: 'detached' });
        await page.getByRole('button', { name: 'Apagar Assistant', exact: true }).click();
        await dialog.waitFor();
        await page.getByRole('button', { name: 'Esperar tareas y salir', exact: true }).click();
        const deadline = Date.now() + 5000;
        while (!closed) { assert.ok(Date.now() < deadline); await new Promise(resolve => setTimeout(resolve, 20)); }
        assert.equal(stopRequests, 2);
      } else {
        await page.getByRole('heading', { name: 'Assistant está apagado', exact: true }).waitFor();
      }
      assert.deepEqual(errors, []);
    } finally { await page.close(); lifecycle.stop(); await app.close(); await rm(directory, { recursive: true, force: true }); }
  }
  console.log('Settings shutdown passed: native request, return to settings, second quit and drain; standalone web shutdown remains supported.');
} finally { await browser.close(); }
