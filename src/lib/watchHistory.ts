const KEY = 'tesla-iptv:recent';
function validIds(value: unknown): number[] {
  return Array.isArray(value)
    ? [...new Set(value.filter((id): id is number => typeof id === 'number' && Number.isSafeInteger(id) && id > 0))].slice(0, 12)
    : [];
}
export function readRecentChannels(): number[] {
  try { return validIds(JSON.parse(localStorage.getItem(KEY) || '[]')); }
  catch { return []; }
}
export function rememberChannel(previous: number[], id: number): number[] {
  const next = validIds([id, ...previous]);
  try { localStorage.setItem(KEY, JSON.stringify(next)); } catch { /* In-memory history still works. */ }
  return next;
}
