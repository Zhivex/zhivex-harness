import { mkdtemp, rm } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
import { createMockLanguageModel } from '@zhivex-ai/agents/testing';
import { startManagedAssistant } from '../src/web/setup.js';
import { startAssistantHost } from '../src/host.js';

const directory = await mkdtemp('/tmp/daily-web-'); let stored: string | null = null;
const app = await startManagedAssistant(directory, { assetsDirectory: fileURLToPath(new URL('../web/dist', import.meta.url)), secrets: { async read() { return stored; }, async write(value) { stored = value; } }, validateProvider: async () => {},
  startHost: input => startAssistantHost({ ...input, engine: { ...input.engine, modelInstance: createMockLanguageModel({ streamEvents: [[{ type: 'text-delta', textDelta: 'Ready' }, { type: 'finish', finishReason: 'stop' }]] }) } }) });
const browser = await chromium.launch({ headless: true });
try {
  const headers = { authorization: `Bearer ${new URLSearchParams(new URL(app.url).hash.slice(1)).get('token')}`, origin: app.origin, 'content-type': 'application/json' };
  const post = async (route: string, body: unknown) => {
    const response = await fetch(app.origin + '/api/setup/' + route, { method: 'POST', headers, body: JSON.stringify(body) });
    if (!response.ok) throw new Error('SETUP_FAILED');
  };
  await post('begin', { name: 'Daily test' });
  await post('provider', { baseURL: 'https://example.test/v1', apiKey: 'offline-test-key', apiMode: 'chat', model: 'test' });
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
  const errors: string[] = []; page.on('pageerror', error => errors.push(error.message));
  await page.goto(app.url);
  await page.getByRole('tab', { name: 'Herramientas' }).click();
  await page.getByLabel('Tareas, recordatorios y notas locales').check();
  await page.getByRole('button', { name: 'Guardar herramientas' }).click();
  await page.getByText('Herramientas guardadas para este agente.').waitFor();
  await page.screenshot({ path: '/tmp/assistant-daily-tools-desktop.png', fullPage: true });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.screenshot({ path: '/tmp/assistant-daily-tools-mobile.png', fullPage: true });
  const overflow = await page.evaluate('document.documentElement.scrollWidth > innerWidth');
  if (overflow) throw new Error('MOBILE_OVERFLOW');
  await page.getByRole('tab', { name: 'Modelo' }).click();
  await page.getByRole('button', { name: 'Empezar a conversar ahora' }).click();
  await page.getByRole('heading', { name: 'Tareas y recordatorios', exact: true }).waitFor();
  await page.getByText('No hay tareas pendientes.').waitFor();
  await page.getByRole('heading', { name: 'Tareas y recordatorios', exact: true }).scrollIntoViewIfNeeded();
  await page.screenshot({ path: '/tmp/assistant-daily-home-mobile.png', fullPage: true });
  if (errors.length) throw new Error(errors.join('\n'));
  console.log('Daily tools setup, persistence, mobile layout and home panel passed.');
} finally { await browser.close(); await app.close(); await rm(directory, { recursive: true, force: true }); }
