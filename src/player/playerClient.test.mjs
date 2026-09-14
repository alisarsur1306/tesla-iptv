import test from 'node:test';
import assert from 'node:assert/strict';
import { CanvasPlayer } from './playerClient.ts';

test('late worker messages cannot revive a paused or replaced channel', (t) => {
  let worker;
  class FakeWorker {
    messages = [];
    terminated = false;
    constructor() { worker = this; }
    postMessage(message) { this.messages.push(message); }
    terminate() { this.terminated = true; }
  }
  const original = Object.getOwnPropertyDescriptor(globalThis, 'Worker');
  Object.defineProperty(globalThis, 'Worker', { configurable: true, value: FakeWorker });
  t.after(() => { if (original) Object.defineProperty(globalThis, 'Worker', original); else delete globalThis.Worker; });
  const events = [];
  let fatal;
  const player = new CanvasPlayer({ transferControlToOffscreen: () => ({}) }, {
    onError: (message, settled) => { fatal = settled; events.push(message); },
    onStats: () => events.push('frame'),
  });
  player.play('/first');
  const first = worker.messages.at(-1).sessionId;
  player.stop();
  worker.onmessage({ data: { t: 'error', sessionId: first, msg: 'late failure' } });
  assert.deepEqual(events, []);
  player.play('/second');
  const second = worker.messages.at(-1).sessionId;
  worker.onmessage({ data: { t: 'stats', sessionId: first, frames: 16 } });
  assert.deepEqual(events, []);
  worker.onmessage({ data: { t: 'stats', sessionId: second, frames: 16 } });
  assert.deepEqual(events, ['frame']);
  worker.onmessage({ data: { t: 'error', sessionId: second, msg: 'STREAM_REJECTED', fatal: true } });
  assert.equal(fatal, true);
  assert.equal(events.at(-1), 'STREAM_REJECTED');
  player.destroy();
  assert.equal(worker.terminated, true);
  assert.equal(worker.onmessage, null);
});
