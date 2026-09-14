// The server has 60 seconds for candidate discovery, fallback and first bytes.
export const STREAM_START_TIMEOUT_MS = 75_000;
export const STREAM_IDLE_TIMEOUT_MS = 20_000;
export const FRAME_IDLE_TIMEOUT_MS = 30_000;

export function frameDeadlineExpired(startedAt: number, lastFrameAt: number | null, now: number): boolean {
  return lastFrameAt === null
    ? now - startedAt >= STREAM_START_TIMEOUT_MS
    : now - lastFrameAt >= FRAME_IDLE_TIMEOUT_MS;
}
