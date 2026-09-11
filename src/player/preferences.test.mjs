import test from 'node:test';
import assert from 'node:assert/strict';
import { readVolume, saveVolume } from './preferences.ts';

function storage(t, value) {
  const original = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');
  Object.defineProperty(globalThis, 'localStorage', { configurable: true, value });
  t.after(() => { if (original) Object.defineProperty(globalThis, 'localStorage', original); else delete globalThis.localStorage; });
}

test('volume survives reload, including mute, and handles malformed storage', (t) => {
  let saved = null;
  storage(t, {
    getItem: () => saved,
    setItem: (_key, value) => { saved = value; },
  });
  assert.equal(readVolume(), 1);
  saveVolume(0);
  assert.equal(readVolume(), 0);
  saveVolume(0.6);
  assert.equal(readVolume(), 0.6);
  saved = 'garbage';
  assert.equal(readVolume(), 1);
  saved = '-4';
  assert.equal(readVolume(), 0);
});

test('unavailable storage never interrupts volume changes', (t) => {
  storage(t, {
    getItem: () => { throw new Error('disabled'); },
    setItem: () => { throw new Error('full'); },
  });
  assert.equal(readVolume(), 1);
  assert.doesNotThrow(() => saveVolume(0.8));
});
