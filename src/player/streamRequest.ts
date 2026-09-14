import { STREAM_START_TIMEOUT_MS, STREAM_IDLE_TIMEOUT_MS } from './timing.ts';

const SAFE_CODES = new Set(['STREAM_TIMEOUT', 'STREAM_PROXY_UNAVAILABLE', 'STREAM_NOT_CONFIGURED', 'STREAM_REJECTED', 'STREAM_UNAVAILABLE', 'STREAM_INVALID_RESPONSE', 'STREAM_ABORTED']);

export class StreamResponseError extends Error {
  readonly status: number;
  readonly retryable: boolean;

  constructor(status: number, code?: string, retryable?: boolean) {
    super(code && SAFE_CODES.has(code) ? code : `HTTP_${status}`);
    this.name = 'StreamResponseError';
    this.status = status;
    this.retryable = retryable ?? (status < 400 || status >= 500 || status === 408 || status === 429);
  }
}

export class StreamTimeoutError extends Error {
  constructor() {
    super('STREAM_TIMEOUT');
    this.name = 'StreamTimeoutError';
  }
}

/** Deadlines cover header wait and each byte read, never decoder backpressure. */
export async function openStream(url: string, session: AbortSignal, timeoutMs?: number) {
  const controller = new AbortController();
  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
  const onAbort = () => {
    controller.abort(session.reason);
    void reader?.cancel().catch(() => {});
  };
  if (session.aborted) onAbort();
  else session.addEventListener('abort', onAbort, { once: true });

  function cancel() {
    session.removeEventListener('abort', onAbort);
    controller.abort();
    void reader?.cancel().catch(() => {});
  }

  async function deadline<T>(operation: () => Promise<T>, ms: number): Promise<T> {
    controller.signal.throwIfAborted();
    let timer: ReturnType<typeof setTimeout> | undefined;
    let aborted: () => void = () => {};
    const expired = new Promise<never>((_resolve, reject) => {
      aborted = () => reject(controller.signal.reason);
      controller.signal.addEventListener('abort', aborted, { once: true });
      timer = setTimeout(() => controller.abort(new StreamTimeoutError()), ms);
    });
    try {
      return await Promise.race([operation(), expired]);
    } catch (error) {
      cancel();
      throw error;
    } finally {
      clearTimeout(timer);
      controller.signal.removeEventListener('abort', aborted);
    }
  }

  try {
    const response = await deadline(() => fetch(url, { signal: controller.signal }), timeoutMs ?? STREAM_START_TIMEOUT_MS);
    if (controller.signal.aborted) {
      void response.body?.cancel().catch(() => {});
      controller.signal.throwIfAborted();
    }
    reader = response.body?.getReader();
    if (!response.ok) {
      let code: string | undefined;
      let retryable: boolean | undefined;
      // Consume at most 8 KiB and two seconds of a JSON failure. Only allowlisted
      // codes reach the worker/UI; never forward server text, URLs or credentials.
      if (reader && /json/i.test(response.headers.get('content-type') || '')) {
        try {
          const text = await deadline(async () => {
            const chunks: Uint8Array[] = [];
            let length = 0;
            while (true) {
              const { value, done } = await reader!.read();
              if (done) break;
              length += value.byteLength;
              if (length > 8192) throw new Error('ERROR_BODY_TOO_LARGE');
              chunks.push(value);
            }
            const bytes = new Uint8Array(length);
            let offset = 0;
            for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
            return new TextDecoder().decode(bytes);
          }, 2000);
          const body: unknown = JSON.parse(text);
          if (body && typeof body === 'object') {
            const failure = body as { code?: unknown; retryable?: unknown };
            if (typeof failure.code === 'string') code = failure.code;
            if (typeof failure.retryable === 'boolean') retryable = failure.retryable;
          }
        } catch {
          session.throwIfAborted();
          // The status remains useful when the optional explanation is malformed.
        }
      }
      throw new StreamResponseError(response.status, code, retryable);
    }
    if (!reader) throw new Error('STREAM_EMPTY');
    return {
      response,
      read: () => deadline(async () => {
        // Empty chunks are not progress and must not renew the deadline.
        while (true) {
          controller.signal.throwIfAborted();
          const result = await reader!.read();
          if (result.done || result.value.byteLength) return result;
        }
      }, timeoutMs ?? STREAM_IDLE_TIMEOUT_MS),
      cancel,
    };
  } catch (error) {
    cancel();
    throw error;
  }
}
