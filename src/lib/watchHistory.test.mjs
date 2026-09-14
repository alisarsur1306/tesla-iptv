import test from 'node:test';
import assert from 'node:assert/strict';
import { readRecentChannels, rememberChannel } from './watchHistory.ts';
Object.defineProperty(globalThis, 'localStorage', { configurable: true, writable: true, value: { getItem: () => null, setItem() {} } });

test('recent history deduplicates channels and is capped at twelve', () => {
  let ids = [];
  for (let id = 1; id <= 15; id++) ids = rememberChannel(ids, id);
  ids = rememberChannel(ids, 10);
  assert.deepEqual(ids, [10, 15, 14, 13, 12, 11, 9, 8, 7, 6, 5, 4]);
});

test('corrupt storage and missing storage do not prevent browsing', (t) => {
  t.mock.property(globalThis, 'localStorage', { getItem: () => '{bad', setItem() { throw new Error('quota'); } });
  assert.deepEqual(readRecentChannels(), []);
  assert.deepEqual(rememberChannel([3], 7), [7, 3]);
});

test('stored history accepts only unique positive integer channel IDs', (t) => {
  t.mock.property(globalThis, 'localStorage', { getItem: () => '[3,3,-1,"7",null,2.5,9]', setItem() {} });
  assert.deepEqual(readRecentChannels(), [3, 9]);
});
