import test from 'node:test';
import assert from 'node:assert/strict';
import { frameDeadlineExpired } from './timing.ts';

test('initial picture gets 75 seconds, including late response headers', () => {
  const start = 1000;
  assert.equal(frameDeadlineExpired(start, null, start + 30_000), false);
  assert.equal(frameDeadlineExpired(start, null, start + 74_999), false);
  assert.equal(frameDeadlineExpired(start, null, start + 75_000), true);
});

test('after the first picture only a 30-second frame stall expires', () => {
  const firstFrame = 74_000;
  assert.equal(frameDeadlineExpired(0, firstFrame, firstFrame + 29_999), false);
  assert.equal(frameDeadlineExpired(0, firstFrame, firstFrame + 30_000), true);
});
