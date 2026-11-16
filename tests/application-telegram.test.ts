import {test, expect} from 'bun:test';
import {mkdtemp, rm} from 'node:fs/promises';
import {startManagedAssistant} from '../packages/core/src/application/assistant/managed/setup.js';

test('Telegram draft pairing requires private owner verification, supports cancellation and never exposes the token', async () => {
  const root = await mkdtemp('/tmp/zhx-pairing-'); let saved: string | null = null, updates: unknown[] = [];
  const token = '123:' + 't'.repeat(30);
  const integrationFetch = Object.assign(async (input: string | URL | Request) => {
    const url = String(input);
    if (url.endsWith('/getMe')) return Response.json({ok: true, result: {is_bot: true, username: 'fixture_bot'}});
    if (url.endsWith('/getWebhookInfo')) return Response.json({ok: true, result: {url: ''}});
    if (url.endsWith('/getUpdates')) return Response.json({ok: true, result: updates});
    throw new Error('Unexpected external request');
  }, {preconnect: fetch.preconnect});
  const manager = await startManagedAssistant(root, {integrationFetch, secrets: {async read() {return saved;}, async write(value) {saved = value;}}});
  try {
    await manager.action('begin', {}); await manager.action('telegram', {token});
    await expect(manager.action('start', {})).rejects.toThrow('SETUP_TELEGRAM_PENDING');
    const code = new URL(manager.state().telegram.url!).searchParams.get('start');
    updates = [{update_id: 1, message: {message_id: 1, from: {id: 7}, chat: {id: 7, type: 'group'}, text: `/start ${code}`}}];
    await manager.action('telegram-check', {}); expect(manager.state().telegram.candidate).toBeUndefined();
    updates = [{update_id: 2, message: {message_id: 2, from: {id: 7}, chat: {id: 7, type: 'private'}, text: `/start ${code}`}}];
    await manager.action('telegram-check', {}); expect(manager.state().telegram.candidate).toBe('7');
    await expect(manager.action('telegram-confirm', {userId: '8'})).rejects.toThrow('TELEGRAM_OWNER_INVALID');
    expect(JSON.stringify(manager.state())).not.toContain(token);
    expect(saved).not.toContain(token);
    await manager.action('telegram-cancel', {}); expect(manager.state().telegram.pending).toBe(false);
    await expect(manager.action('telegram-confirm', {userId: '7'})).rejects.toThrow('SETUP_PAIR_EXPIRED');
    await manager.action('telegram', {token});
    const newCode = new URL(manager.state().telegram.url!).searchParams.get('start'); expect(newCode).not.toBe(code);
    await manager.action('telegram-check', {}); expect(manager.state().telegram.candidate).toBeUndefined();
    updates = [{update_id: 3, message: {message_id: 3, from: {id: 7}, chat: {id: 7, type: 'private'}, text: `/start ${newCode}`}}];
    await manager.action('telegram-check', {}); await manager.action('telegram-confirm', {userId: '7'});
    expect(manager.state().telegram.configured).toBe(true); expect(typeof saved).toBe('string'); expect(String(saved)).toContain(token); expect(JSON.stringify(manager.state())).not.toContain(token);
    await manager.action('telegram-remove', {}); expect(manager.state().telegram.configured).toBe(false); expect(saved).not.toContain(token);
  } finally {await manager.close(); await rm(root, {recursive: true, force: true});}
});
