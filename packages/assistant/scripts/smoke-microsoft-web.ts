import { mkdtemp, rm } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { chromium, type Browser } from 'playwright';
import { createMockLanguageModel } from '@zhivex-ai/agents/testing';
import { startManagedAssistant } from '../src/web/setup.js';
import { startAssistantHost } from '../src/host.js';

const directory = await mkdtemp('/tmp/microsoft-web-'); let stored: string | null = null;
const integrationFetch = Object.assign(async (input: unknown) => {
  const url = String(input);
  if (url.includes('/token')) return Response.json({ token_type: 'Bearer', access_token: 'mock-access', refresh_token: 'mock-refresh', expires_in: 3600, scope: 'User.Read Mail.ReadWrite Calendars.ReadWrite' });
  if (url.includes('/me?')) return Response.json({ id: 'account1', mail: 'owner@company.test' });
  if (url.includes('/calendarView')) return Response.json({ value: [] });
  throw new Error('UNEXPECTED_NETWORK');
}, { preconnect: fetch.preconnect });
const app = await startManagedAssistant(directory, { integrationFetch, assetsDirectory: fileURLToPath(new URL('../web/dist', import.meta.url)), secrets: { async read() { return stored; }, async write(value) { stored = value; } }, validateProvider: async () => {},
  startHost: input => startAssistantHost({ ...input, engine: { ...input.engine, modelInstance: createMockLanguageModel({ streamEvents: [[{ type: 'text-delta', textDelta: 'Ready' }, { type: 'finish', finishReason: 'stop' }]] }) } }) });
let browser: Browser | undefined;
try {
  browser = await chromium.launch({ headless: true });
  const headers = { authorization: `Bearer ${new URLSearchParams(new URL(app.url).hash.slice(1)).get('token')}`, origin: app.origin, 'content-type': 'application/json' };
  for (const [route, body] of [['begin', { name: 'Microsoft test' }], ['provider', { baseURL: 'https://example.test/v1', apiKey: 'offline-test', model: 'test', apiMode: 'chat' }]] as const) {
    const response = await fetch(app.origin + '/api/setup/' + route, { method: 'POST', headers, body: JSON.stringify(body) });
    if (!response.ok) throw new Error('SETUP_FAILED');
  }
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
  const errors: string[] = []; page.on('pageerror', error => errors.push(error.message));
  await page.goto(app.url); await page.getByRole('tab', { name: 'Herramientas' }).click();
  await page.getByLabel('Application (client) ID').fill('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa');
  await page.getByLabel('Directory (tenant) ID').fill('bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb');
  await page.getByText('Qué configurar en Entra ID').click();
  await page.screenshot({ path: '/tmp/assistant-microsoft-desktop.png', fullPage: true });
  await page.getByRole('button', { name: 'Autorizar en Microsoft', exact: true }).click();
  const link = page.getByRole('link', { name: 'Abrir autorización de la cuenta' }); await link.waitFor();
  const auth = new URL((await link.getAttribute('href'))!), callback = new URL(auth.searchParams.get('redirect_uri')!);
  callback.searchParams.set('code', 'test-code'); callback.searchParams.set('state', auth.searchParams.get('state')!);
  const response = await fetch(callback); if (!response.ok) throw new Error('CALLBACK_FAILED');
  await page.getByRole('status').filter({ hasText: 'Conectado: owner@company.test' }).waitFor();
  await page.setViewportSize({ width: 390, height: 844 });
  await page.getByRole('heading', { name: 'Microsoft · Outlook empresarial' }).scrollIntoViewIfNeeded();
  await page.screenshot({ path: '/tmp/assistant-microsoft-mobile.png', fullPage: true });
  if (await page.evaluate('document.documentElement.scrollWidth > innerWidth')) throw new Error('MOBILE_OVERFLOW');
  await page.getByRole('tab', { name: 'Modelo' }).click(); await page.getByRole('button', { name: 'Empezar a conversar ahora' }).click();
  await page.getByRole('button', { name: /configura/i }).first().waitFor();
  const state = await (await fetch(app.origin + '/api/setup', { headers })).json() as any;
  if (!state.ready || !state.profiles[0].integrations.outlookCalendar) throw new Error('MICROSOFT_MODULE_MISSING');
  if (errors.length) throw new Error(errors.join('\n'));
  console.log('Microsoft form, OAuth callback, connected account, agent activation and mobile layout passed.');
} finally { await browser?.close(); await app.close(); await rm(directory, { recursive: true, force: true }); }
