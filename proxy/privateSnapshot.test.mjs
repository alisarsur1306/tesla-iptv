import test from 'node:test';
import assert from 'node:assert/strict';
import { readConditionalSnapshot } from './privateSnapshot.mjs';

test('conditional backup reads send ETag and accept 304 without parsing a body', async () => {
  const result = await readConditionalSnapshot({ url: 'https://api.github.com/repos/owner/private/contents/file.json', headers: { Authorization: 'Bearer PRIVATE' } }, '"one"', async (_url, options) => {
    assert.equal(options.headers['If-None-Match'], '"one"');
    assert.equal(options.redirect, 'error');
    return new Response(null, { status: 304 });
  });
  assert.deepEqual(result, { unchanged: true });
});

test('bad backup responses do not produce a replacement snapshot', async () => {
  await assert.rejects(readConditionalSnapshot({ url: 'https://api.github.com/file', headers: {} }, '', async () => new Response('denied', { status: 403 })), /unavailable/);
  await assert.rejects(readConditionalSnapshot({ url: 'https://api.github.com/file', headers: {} }, '', async () => new Response('{bad')), /JSON/);
});
