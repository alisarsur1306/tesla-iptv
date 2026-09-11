export class StreamTimeoutError extends Error {
  constructor() {
    super('STREAM_TIMEOUT');
    this.name = 'StreamTimeoutError';
  }
}

/** Deadlines cover header wait and each byte read, never decoder backpressure. */
export async function openStream(url: string, session: AbortSignal, timeoutMs = 20_000) {
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

  async function deadline<T>(operation: () => Promise<T>): Promise<T> {
    controller.signal.throwIfAborted();
    let timer: ReturnType<typeof setTimeout> | undefined;
    let aborted: () => void = () => {};
    const expired = new Promise<never>((_resolve, reject) => {
      aborted = () => reject(controller.signal.reason);
      controller.signal.addEventListener('abort', aborted, { once: true });
      timer = setTimeout(() => controller.abort(new StreamTimeoutError()), timeoutMs);
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
    const response = await deadline(() => fetch(url, { signal: controller.signal }));
    if (controller.signal.aborted) {
      void response.body?.cancel().catch(() => {});
      controller.signal.throwIfAborted();
    }
    if (!response.ok || !response.body) {
      void response.body?.cancel().catch(() => {});
      throw new Error(response.ok ? 'STREAM_EMPTY' : `HTTP_${response.status}`);
    }
    reader = response.body.getReader();
    return {
      response,
      read: () => deadline(async () => {
        // Empty chunks are not progress and must not renew the deadline.
        while (true) {
          controller.signal.throwIfAborted();
          const result = await reader!.read();
          if (result.done || result.value.byteLength) return result;
        }
      }),
      cancel,
    };
  } catch (error) {
    cancel();
    throw error;
  }
}
