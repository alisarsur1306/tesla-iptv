export class RequestTimeout extends Error {
  constructor() {
    super('The server did not respond in time.');
    this.name = 'RequestTimeout';
  }
}

export class HttpError extends Error {
  readonly status: number;
  constructor(status: number) {
    super(`Request failed (${status})`);
    this.name = 'HttpError';
    this.status = status;
  }
}

/** One deadline covers headers AND JSON, and cancellation releases all listeners. */
export async function requestJson<T>(url: string, options: { timeoutMs?: number; signal?: AbortSignal } = {}): Promise<T> {
  const controller = new AbortController();
  let rejectPending: (reason: unknown) => void = () => {};
  const interrupted = new Promise<never>((_, reject) => { rejectPending = reject; });
  const cancel = () => {
    const reason = options.signal?.reason ?? new DOMException('Cancelled', 'AbortError');
    controller.abort(reason);
    rejectPending(reason);
  };
  options.signal?.addEventListener('abort', cancel, { once: true });
  const timer = setTimeout(() => {
    const error = new RequestTimeout();
    controller.abort(error);
    rejectPending(error);
  }, options.timeoutMs ?? 30_000);
  try {
    if (options.signal?.aborted) cancel();
    const response = async () => {
      if (controller.signal.aborted) throw controller.signal.reason;
      const res = await fetch(url, { signal: controller.signal, cache: 'no-store' });
      if (!res.ok) {
        void res.body?.cancel().catch(() => {});
        throw new HttpError(res.status);
      }
      return await res.json() as T;
    };
    return await Promise.race([response(), interrupted]);
  } finally {
    clearTimeout(timer);
    options.signal?.removeEventListener('abort', cancel);
  }
}
