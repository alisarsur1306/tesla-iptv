import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { fetch as request } from 'undici';
import { resolvingProxy } from './resolvingProxy.mjs';

test('local resolution sends a numeric CONNECT through the proxy and preserves the provider Host', async t => {
  const seen = [];
  const proxy = http.createServer();
  const sockets = new Set();
  proxy.on('connection', socket => { sockets.add(socket); socket.on('close', () => sockets.delete(socket)); });
  proxy.on('connect', (req, socket) => {
    seen.push(req.url);
    socket.write('HTTP/1.1 200 Connection Established\r\n\r\n');
    socket.once('data', bytes => { seen.push(bytes.toString()); socket.end('HTTP/1.1 200 OK\r\nContent-Length: 5\r\nConnection: close\r\n\r\nVIDEO'); });
  });
  await new Promise(resolve => proxy.listen(0, '127.0.0.1', resolve));
  const agent = resolvingProxy(`http://127.0.0.1:${proxy.address().port}`, { lookup: async host => { assert.equal(host, 'provider.example'); return { address: '203.0.113.7', family: 4 }; } });
  t.after(async () => { await agent.destroy(); for (const socket of sockets) socket.destroy(); proxy.close(); });
  const response = await request('http://provider.example:8080/live/account/channel.ts', { dispatcher: agent, signal: AbortSignal.timeout(3000) });
  assert.equal(await response.text(), 'VIDEO');
  assert.equal(seen[0], '203.0.113.7:8080');
  assert.match(seen[1], /host: provider\.example:8080/i);
  assert.match(seen[1], /GET \/live\/account\/channel\.ts/);
});

test('private DNS answers fail before contacting the proxy', async () => {
  const agent = resolvingProxy('http://127.0.0.1:1', { lookup: async () => ({ address: '127.0.0.1', family: 4 }) });
  try {
    await assert.rejects(request('http://provider.example/stream', { dispatcher: agent, signal: AbortSignal.timeout(1000) }), error => error.cause?.code === 'STREAM_DNS_UNSAFE');
  } finally { await agent.destroy(); }
});
