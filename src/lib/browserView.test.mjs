import test from 'node:test';
import assert from 'node:assert/strict';
import {
  ALL_ID, BROWSER_VIEW_KEY, FAVORITES_ID, PAGE_SIZE, RECENT_ID,
  normalizeBrowserView, readBrowserView, writeBrowserView, resolveBrowserCategory, resolveRecentChannels,
} from './browserView.ts';

function memoryStorage(initial) {
  const values = new Map(initial ? [[BROWSER_VIEW_KEY, initial]] : []);
  return { getItem: (key) => values.get(key) ?? null, setItem: (key, value) => values.set(key, value) };
}

test('reload retains the group, multilingual search, expanded page and scroll position', () => {
  const storage = memoryStorage();
  const view = { category: 'sports', search: 'ספורט رياضة', visibleCount: 480, scrollTop: 4200 };
  writeBrowserView(view, storage);
  assert.deepEqual(readBrowserView(ALL_ID, storage), view);
  assert.equal(storage.getItem(BROWSER_VIEW_KEY).includes('stream'), false, 'never duplicate the channel catalogue');
});

test('unavailable or corrupted storage uses a usable landing view without throwing', () => {
  for (const storage of [memoryStorage('{broken'), memoryStorage('{"version":2}'), {
    getItem() { throw new Error('denied'); }, setItem() { throw new Error('full'); },
  }]) {
    const view = readBrowserView(FAVORITES_ID, storage);
    assert.deepEqual(view, { category: FAVORITES_ID, search: '', visibleCount: PAGE_SIZE, scrollTop: 0 });
    assert.doesNotThrow(() => writeBrowserView(view, storage));
  }
});

test('stored values cannot cause an unbounded render or invalid scroll position', () => {
  assert.deepEqual(normalizeBrowserView({ category: [], search: 3, visibleCount: Infinity, scrollTop: -12 }), {
    category: ALL_ID, search: '', visibleCount: PAGE_SIZE, scrollTop: 0,
  });
  const view = normalizeBrowserView({ category: 'x'.repeat(257), search: 'a'.repeat(5000), visibleCount: 9e9, scrollTop: 9e9 });
  assert.equal(view.category, ALL_ID);
  assert.equal(view.search.length, 128);
  assert.equal(view.visibleCount, 12_000);
  assert.equal(view.scrollTop, 10_000_000);
});

test('slow catalogue loading preserves the saved group; a removed group falls back to all', () => {
  assert.equal(resolveBrowserCategory('sports', [], false), 'sports');
  assert.equal(resolveBrowserCategory('sports', ['sports', 'news'], true), 'sports');
  assert.equal(resolveBrowserCategory('sports', ['news'], true), ALL_ID);
  for (const category of [ALL_ID, FAVORITES_ID, RECENT_ID]) {
    assert.equal(resolveBrowserCategory(category, [], true), category);
  }
});

test('recent history ignores removed IDs and duplicates, preserving most-recent order and current data', () => {
  const current = [{ stream_id: 1, name: 'Updated channel' }, { stream_id: 2, name: 'Second' }];
  assert.deepEqual(resolveRecentChannels([99, 2, 2, 1], current), [current[1], current[0]]);
  assert.deepEqual(resolveRecentChannels([99], current), []);
  const many = Array.from({ length: 100 }, (_, i) => ({ stream_id: i + 1 }));
  assert.equal(resolveRecentChannels(many.map((s) => s.stream_id), many).length, 20);
});
