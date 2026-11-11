import { lookup } from 'node:dns/promises';
import { request } from 'node:https';
import { isIP } from 'node:net';

/** Reject non-global addresses before connecting, and pin the checked DNS answer. */
export function publicAddress(address: string) {
  if (isIP(address) === 4) {
    const [a,b,c] = address.split('.').map(Number) as [number,number,number];
    return !(a === 0 || a === 10 || a === 127 || a >= 224 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && (b === 168 || b === 0 || (b === 88 && c === 99))) || (a === 100 && b >= 64 && b <= 127) ||
      (a === 198 && (b === 18 || b === 19 || (b === 51 && c === 100))) || (a === 203 && b === 0 && c === 113));
  }
  // IPv6 globally routable unicast only, excluding documentation and transition blocks.
  const normalized = address.toLowerCase();
  return isIP(address) === 6 && /^[23][0-9a-f]{3}:/.test(normalized) && !normalized.startsWith('2001:') && !normalized.startsWith('2002:') && !normalized.startsWith('3fff:');
}
export function publicUrl(input: string) {
  const url = new URL(input);
  if (url.protocol !== 'https:' || (url.port && url.port !== '443') || url.username || url.password || url.hash || url.hostname.endsWith('.') ||
    !url.hostname.includes('.') || /(?:^|\.)(?:localhost|local|internal|test|invalid)$/.test(url.hostname)) throw new Error('WEB_URL_REJECTED');
  const literal = url.hostname.replace(/^\[|\]$/g, '');
  if (isIP(literal) && !publicAddress(literal)) throw new Error('WEB_URL_REJECTED');
  return url;
}
export async function readPublicPage(input: string, signal?: AbortSignal, transport: {
  resolve(hostname: string): Promise<{ address: string; family: number }[]>; request: typeof request;
} = { resolve: hostname => lookup(hostname, { all: true }), request }) {
  const deadline = signal ? AbortSignal.any([signal, AbortSignal.timeout(15000)]) : AbortSignal.timeout(15000);
  deadline.throwIfAborted();
  const url = publicUrl(input);
  const addresses = await new Promise<{ address: string; family: number }[]>((resolve, reject) => {
    const abort = () => reject(new Error('WEB_READ_CANCELLED'));
    deadline.addEventListener('abort', abort, { once: true });
    transport.resolve(url.hostname).then(resolve, reject).finally(() => deadline.removeEventListener('abort', abort));
  });
  if (!addresses.length || addresses.some(a => !publicAddress(a.address))) throw new Error('WEB_ADDRESS_REJECTED');
  const selected = addresses[0]!;
  const text = await new Promise<string>((resolve, reject) => {
    const req = transport.request(url, { method: 'GET', agent: false,
      signal: deadline,
      headers: { accept: 'text/html,text/plain', 'accept-encoding': 'identity', 'user-agent': 'ZhivexAssistant/1.0' },
      lookup: (_hostname, options, callback) => {
        if (options.all) callback(null, [selected]); else callback(null, selected.address, selected.family);
      }
    }, response => {
      if (response.statusCode !== 200 || !/^(text\/html|text\/plain)(?:;|$)/i.test(String(response.headers['content-type'])) ||
        (response.headers['content-encoding'] && response.headers['content-encoding'] !== 'identity')) {
        response.destroy(); reject(new Error('WEB_RESPONSE_REJECTED')); return;
      }
      const parts: Buffer[] = []; let size = 0;
      response.on('data', (chunk: Buffer) => { size += chunk.length; if (size > 512 * 1024) { response.destroy(new Error('WEB_PAGE_TOO_LARGE')); return; } parts.push(chunk); });
      response.on('end', () => resolve(Buffer.concat(parts).toString('utf8')));
      response.on('error', () => reject(new Error('WEB_READ_FAILED')));
    });
    req.on('error', () => reject(new Error('WEB_READ_FAILED'))); req.end();
  });
  const plain = text.replace(/<(script|style|noscript)\b[^>]*>[\s\S]*?<\/\1\s*>/gi, ' ').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
  return { url: url.href, text: plain.slice(0, 24000), truncated: plain.length > 24000, fetchedAt: new Date().toISOString() };
}
