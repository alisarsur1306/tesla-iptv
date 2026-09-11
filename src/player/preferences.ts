const VOLUME_KEY = 'tesla-player-volume';

export function readVolume(): number {
  try {
    const saved = localStorage.getItem(VOLUME_KEY);
    if (saved === null || saved.trim() === '') return 1;
    const value = Number(saved);
    return Number.isFinite(value) ? Math.max(0, Math.min(1, value)) : 1;
  } catch {
    return 1;
  }
}

export function saveVolume(value: number): void {
  try {
    localStorage.setItem(VOLUME_KEY, String(Math.max(0, Math.min(1, value))));
  } catch {
    // Private mode and quota limits must not interrupt playback.
  }
}
