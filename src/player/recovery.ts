export type RecoveryState = {
  phase: 'starting' | 'playing' | 'retrying' | 'failed' | 'paused' | 'destroyed';
  attempt: number;
  error?: string;
};

/** One retry budget per viewing session; stopping invalidates pending work. */
export class PlaybackRecovery {
  private callbacks: { restart: () => void; stop: () => void; changed: (state: RecoveryState) => void };
  private phase: RecoveryState['phase'] = 'paused';
  private attempt = 0;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private healthySince: number | undefined;
  private lastProgress: number | undefined;
  private stalled = false;

  constructor(callbacks: PlaybackRecovery['callbacks']) {
    this.callbacks = callbacks;
  }

  private change(phase: RecoveryState['phase'], error?: string) {
    this.phase = phase;
    this.callbacks.changed({ phase, attempt: this.attempt, error });
  }

  private cancel() {
    clearTimeout(this.timer);
    this.timer = undefined;
    this.healthySince = undefined;
    this.lastProgress = undefined;
  }

  play() {
    if (this.phase === 'destroyed') return;
    this.cancel();
    this.attempt = 0;
    this.stalled = false;
    this.change('starting');
    this.callbacks.restart();
  }

  error(error: string) {
    if (['paused', 'destroyed', 'retrying', 'failed'].includes(this.phase)) return;
    this.cancel();
    this.callbacks.stop();
    if (this.attempt >= 3) {
      this.change('failed', error);
      return;
    }
    this.attempt++;
    this.change('retrying', error);
    this.timer = setTimeout(() => {
      this.timer = undefined;
      if (this.phase !== 'retrying') return;
      this.stalled = false;
      this.change('starting');
      this.callbacks.restart();
    }, 1000 * 2 ** (this.attempt - 1));
  }

  progress() {
    if (this.phase !== 'starting' && this.phase !== 'playing') return;
    const now = Date.now();
    if (this.healthySince === undefined || this.lastProgress === undefined || now - this.lastProgress > 3000) this.healthySince = now;
    this.lastProgress = now;
    this.stalled = false;
    if (this.healthySince !== undefined && now - this.healthySince >= 20_000) this.attempt = 0;
    if (this.phase !== 'playing') this.change('playing');
  }

  setStalled(active: boolean) {
    this.stalled = active;
    if (active) this.healthySince = undefined;
  }

  /** Called only on online/visible transitions. Healthy playback is untouched. */
  recover() {
    if (this.phase === 'failed' || this.phase === 'retrying' || (this.stalled && this.phase === 'playing')) this.play();
  }

  pause() {
    if (this.phase === 'destroyed') return;
    this.cancel();
    this.callbacks.stop();
    this.change('paused');
  }

  destroy() {
    this.cancel();
    this.callbacks.stop();
    this.change('destroyed');
  }
}
