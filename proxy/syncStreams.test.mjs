import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { uploadPrivateSnapshot } from './syncStreams.mjs';

test('sync refuses a public repository before sending any saved stream credentials', async () => {
  const calls = [];
  await assert.rejects(uploadPrivateSnapshot({ repository: 'owner/public', snapshot: { entries: [] }, run: async args => { calls.push(args); return 'false'; } }), /private repository/);
  assert.equal(calls.length, 1);
  assert.ok(!calls.flat().includes('PUT'));
});

test('unchanged private snapshot skips PUT entirely', async () => {
  const snapshot = { version: 1, entries: [] };
  const bytes = Buffer.from(JSON.stringify(snapshot));
  const sha = createHash('sha1').update(`blob ${bytes.length}\0`).update(bytes).digest('hex');
  const calls = [];
  const result = await uploadPrivateSnapshot({ repository: 'owner/private', snapshot, run: async args => {
    calls.push(args);
    if (args.includes('.private')) return 'true';
    if (args.includes('.sha')) return sha;
    throw new Error('An unchanged snapshot must not be written');
  } });
  assert.equal(result, null);
  assert.equal(calls.some(args => args.includes('PUT')), false);
});

test('a private revision conflict fails without an unconditional overwrite', async () => {
  let writes = 0;
  await assert.rejects(uploadPrivateSnapshot({ repository: 'owner/private', snapshot: { entries: [] }, run: async args => {
    if (args.includes('.private')) return 'true';
    if (args.includes('.sha')) return 'old-sha';
    writes++;
    const payload = JSON.parse(await readFile(args[args.indexOf('--input') + 1], 'utf8'));
    assert.equal(payload.sha, 'old-sha');
    throw new Error('Conflict HTTP 409');
  } }), /Conflict/);
  assert.equal(writes, 1);
});

test('private snapshot upload uses a private temporary JSON file and preserves the existing SHA', async () => {
  let payload;
  let payloadPath;
  const result = await uploadPrivateSnapshot({ repository: 'owner/private', snapshot: { version: 1, entries: [{ url: 'https://video.example/PRIVATE_TOKEN' }] }, run: async args => {
    if (args.includes('.private')) return 'true';
    if (args.includes('.sha')) return 'previous-sha';
    payloadPath = args[args.indexOf('--input') + 1];
    payload = JSON.parse(await readFile(payloadPath, 'utf8'));
    assert.equal(args.includes('PUT'), true);
    assert.doesNotMatch(args.join(' '), /PRIVATE_TOKEN/);
    return '{"commit":{"sha":"new-sha"}}';
  } });
  assert.equal(payload.sha, 'previous-sha');
  assert.match(Buffer.from(payload.content, 'base64').toString(), /PRIVATE_TOKEN/);
  assert.equal(result, 'new-sha');
  await assert.rejects(readFile(payloadPath), { code: 'ENOENT' });
});
