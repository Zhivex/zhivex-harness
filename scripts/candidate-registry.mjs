// Read-only loopback registry for installed acceptance; never publishes or mutates tarballs.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { spawnSync } from 'node:child_process';
const artifact = process.argv[2];
assert(artifact && process.send, 'Run as an IPC child with one Harness tarball');
const bytes = await readFile(artifact);
const unpack = spawnSync('tar', ['-xOf', artifact, 'package/package.json'], { encoding: 'utf8' });
assert.equal(unpack.status, 0);
const manifest = JSON.parse(unpack.stdout);
assert.equal(manifest.name, '@zhivex-ai/harness');
const integrity = `sha512-${createHash('sha512').update(bytes).digest('base64')}`;
const server = createServer((request, response) => {
  if (request.method !== 'GET' && request.method !== 'HEAD') {
    response.writeHead(405); response.end(); return;
  }
  let pathname;
  try { pathname = decodeURIComponent(new URL(request.url, 'http://localhost').pathname); }
  catch { response.writeHead(400); response.end(); return; }
  if (pathname === '/candidate.tgz') {
    response.writeHead(200, { 'content-type': 'application/octet-stream', 'content-length': bytes.length });
    response.end(request.method === 'HEAD' ? undefined : bytes); return;
  }
  if (pathname === '/@zhivex-ai/harness') {
    const origin = `http://127.0.0.1:${server.address().port}`;
    const version = { ...manifest, dist: { integrity, tarball: `${origin}/candidate.tgz` } };
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end(JSON.stringify({ name: manifest.name, 'dist-tags': { latest: manifest.version },
      versions: { [manifest.version]: version } })); return;
  }
  // Fixed public registry destination. Request headers and credentials are never proxied.
  const target = new URL('https://registry.npmjs.org');
  target.pathname = new URL(request.url, 'http://localhost').pathname;
  response.writeHead(302, { location: target.href }); response.end();
});
server.listen(0, '127.0.0.1', () => process.send({ url: `http://127.0.0.1:${server.address().port}`, integrity }));
process.on('disconnect', () => { server.close(); server.closeAllConnections(); });
