import test from 'node:test';
import assert from 'node:assert/strict';
import { PlaybackRecovery } from './recovery.ts';

function setup(t) {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'] });
  const events = [];
  let starts = 0;
  let stops = 0;
  const recovery = new PlaybackRecovery({
    restart: () => starts++,
    stop: () => stops++,
    changed: (state) => events.push(state),
  });
  recovery.play();
  return { recovery, events, starts: () => starts, stops: () => stops };
}

test('network failures use a delayed, bounded retry budget', (t) => {
  const x = setup(t);
  for (const delay of [1000, 2000, 4000]) {
    const before = x.starts();
    x.recovery.error('network');
    x.recovery.error('duplicate callback');
    assert.equal(x.starts(), before);
    t.mock.timers.tick(delay - 1);
    assert.equal(x.starts(), before);
    t.mock.timers.tick(1);
    assert.equal(x.starts(), before + 1);
  }
  x.recovery.error('network');
  t.mock.timers.tick(100_000);
  assert.equal(x.starts(), 4);
  assert.equal(x.events.at(-1).phase, 'failed');
  x.recovery.play();
  assert.equal(x.starts(), 5, 'manual retry gets a fresh budget');
  x.recovery.destroy();
});

for (const action of ['pause', 'destroy']) {
  test(`${action} cancels delayed retries and suppresses stale events`, (t) => {
    const x = setup(t);
    x.recovery.error('network');
    x.recovery[action]();
    x.recovery.error('late worker failure');
    x.recovery.progress();
    x.recovery.recover();
    t.mock.timers.tick(100_000);
    assert.equal(x.starts(), 1);
    assert.equal(x.events.at(-1).phase, action === 'pause' ? 'paused' : 'destroyed');
  });
}

test('brief success does not reset retries; sustained frames do', (t) => {
  const x = setup(t);
  x.recovery.error('network');
  t.mock.timers.tick(1000);
  x.recovery.progress();
  x.recovery.error('network again');
  assert.equal(x.events.at(-1).attempt, 2);
  t.mock.timers.tick(2000);
  for (let i = 0; i < 25; i++) {
    x.recovery.progress();
    t.mock.timers.tick(1000);
  }
  x.recovery.error('later outage');
  assert.equal(x.events.at(-1).attempt, 1);
  x.recovery.destroy();
});

test('online/visible recovery never interrupts healthy or paused playback', (t) => {
  const x = setup(t);
  x.recovery.progress();
  x.recovery.recover();
  assert.equal(x.starts(), 1);
  x.recovery.setStalled(true);
  x.recovery.recover();
  assert.equal(x.starts(), 2);
  x.recovery.pause();
  x.recovery.setStalled(true);
  x.recovery.recover();
  assert.equal(x.starts(), 2);
  x.recovery.destroy();
});

test('sustained frames after a brief rebuffer restore the retry budget', (t) => {
  const x = setup(t);
  x.recovery.error('network');
  t.mock.timers.tick(1000);
  x.recovery.progress();
  x.recovery.setStalled(true);
  t.mock.timers.tick(500);
  x.recovery.setStalled(false);
  for (let i = 0; i < 25; i++) {
    x.recovery.progress();
    t.mock.timers.tick(1000);
  }
  x.recovery.error('later outage');
  assert.equal(x.events.at(-1).attempt, 1);
  x.recovery.destroy();
});

test('a settled refusal skips automatic retries but still permits manual retry', (t) => {
  const x = setup(t);
  x.recovery.error('STREAM_REJECTED', true);
  t.mock.timers.tick(100_000);
  x.recovery.recover();
  assert.equal(x.starts(), 1);
  assert.equal(x.events.at(-1).phase, 'failed');
  x.recovery.play();
  assert.equal(x.starts(), 2);
  x.recovery.destroy();
});
