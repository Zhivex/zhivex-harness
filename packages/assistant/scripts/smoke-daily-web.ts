import { mkdtemp, rm } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { chromium, type Browser } from 'playwright';
import { createMockLanguageModel } from '@zhivex-ai/agents/testing';
import { startManagedAssistant } from '../src/web/setup.js';
import { startAssistantHost } from '../src/host.js';

const directory = await mkdtemp('/tmp/daily-web-'); let stored: string | null = null;
const app = await startManagedAssistant(directory, { assetsDirectory: fileURLToPath(new URL('../web/dist', import.meta.url)), secrets: { async read() { return stored; }, async write(value) { stored = value; } }, validateProvider: async () => {},
  startHost: input => startAssistantHost({ ...input, engine: { ...input.engine, modelInstance: createMockLanguageModel({ streamEvents: [[{ type: 'text-delta', textDelta: 'Ready' }, { type: 'finish', finishReason: 'stop' }]] }) } }) });
let browser: Browser | undefined;
try {
  browser = await chromium.launch({ headless: true });
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
  await page.getByLabel('Configurar avisos proactivos y seguimientos desde el chat').check();
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
  await page.getByRole('button', { name: 'Configurar avisos' }).click();
  await page.getByLabel('Activar avisos', { exact: true }).check();
  await page.getByLabel('Zona horaria', { exact: true }).fill('America/Argentina/Buenos_Aires');
  await page.getByLabel('Máximo de avisos por día').fill('3');
  await page.getByRole('button', { name: 'Guardar preferencias' }).click();
  await page.getByRole('heading', { name: 'Avisos proactivos · Activos', exact: true }).waitFor();
  await page.reload();
  await page.getByRole('heading', { name: 'Avisos proactivos · Activos', exact: true }).waitFor();
  const daily = await fetch(app.origin + '/api/daily', { headers }).then(r => r.json()) as any;
  if (daily.proactive?.policy?.maxPerDay !== 3 || daily.proactive?.policy?.timeZone !== 'America/Argentina/Buenos_Aires') throw new Error('PROACTIVE_POLICY_NOT_PERSISTED');
  const rejected = await fetch(app.origin + '/api/proactive/policy', { method: 'POST', headers: { 'content-type': 'application/json', origin: app.origin }, body: JSON.stringify(daily.proactive.policy) });
  if (rejected.status !== 401) throw new Error('PROACTIVE_AUTH_BYPASS');
  await page.getByRole('button', { name: 'Pausar avisos', exact: true }).click();
  await page.getByRole('heading', { name: 'Avisos proactivos · Pausados', exact: true }).waitFor();
  if (await page.evaluate('document.documentElement.scrollWidth > innerWidth')) throw new Error('PROACTIVE_MOBILE_OVERFLOW');
  await page.getByRole('heading', { name: 'Tareas y recordatorios', exact: true }).scrollIntoViewIfNeeded();
  await page.screenshot({ path: '/tmp/assistant-daily-home-mobile.png', fullPage: true });
  if (errors.length) throw new Error(errors.join('\n'));
  console.log('Daily tools setup, persistence, mobile layout and home panel, proactive policy persistence, pause and authentication passed.');
} finally { await browser?.close(); await app.close(); await rm(directory, { recursive: true, force: true }); }
