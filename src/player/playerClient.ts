// Main-thread handle for the WebCodecs decode worker. Transfers a canvas's
// control to the worker (OffscreenCanvas) and relays status. No <video> is ever
// created — the canvas is the only surface.

export interface PlayerStatus {
  frames?: number;
  buffer?: number;
  ready?: boolean;
}

export interface PlayerCallbacks {
  onReady?: () => void;
  onError?: (msg: string) => void;
  onStats?: (s: { frames: number; buffer: number }) => void;
  onLog?: (msg: string, level: string) => void;
  /** Fired with the first PTS so an audio engine can share the clock (later phase). */
  onFirstPts?: (ptsMs: number) => void;
  /** Raw audio PES payloads (later phase decodes these). */
  onAudio?: (data: ArrayBuffer, ptsMs: number) => void;
}

export class CanvasPlayer {
  private worker: Worker;
  private cb: PlayerCallbacks;

  /** Transfers `canvas` control to the worker. The canvas must not have had a
   *  2D/WebGL context obtained on the main thread already. */
  constructor(canvas: HTMLCanvasElement, cb: PlayerCallbacks = {}) {
    this.cb = cb;
    this.worker = new Worker(new URL('./decoderWorker.ts', import.meta.url), { type: 'module' });
    this.worker.onmessage = (e: MessageEvent) => this.onMessage(e.data);
    const offscreen = canvas.transferControlToOffscreen();
    this.worker.postMessage({ t: 'init', canvas: offscreen }, [offscreen]);
  }

  play(m3u8Url: string): void {
    this.worker.postMessage({ t: 'play', url: m3u8Url });
  }

  stop(): void {
    this.worker.postMessage({ t: 'stop' });
  }

  destroy(): void {
    try {
      this.worker.postMessage({ t: 'stop' });
    } catch {
      /* ignore */
    }
    this.worker.terminate();
  }

  private onMessage(m: {
    t: string;
    msg?: string;
    level?: string;
    frames?: number;
    buffer?: number;
    pts?: number;
    data?: ArrayBuffer;
    width?: number;
    height?: number;
  }) {
    switch (m.t) {
      case 'ready':
        this.cb.onReady?.();
        break;
      case 'error':
        this.cb.onError?.(m.msg || 'unknown error');
        break;
      case 'stats':
        this.cb.onStats?.({ frames: m.frames || 0, buffer: m.buffer || 0 });
        break;
      case 'log':
        this.cb.onLog?.(m.msg || '', m.level || 'info');
        break;
      case 'firstPTS':
        this.cb.onFirstPts?.(m.pts || 0);
        break;
      case 'audio':
        if (m.data) this.cb.onAudio?.(m.data, m.pts || 0);
        break;
      // 'canvasResize' is informational; the OffscreenCanvas already resized.
    }
  }
}
