import { createHash } from 'node:crypto';
import { accountScope, publicStreamUrl, snapshotFromCatalogue } from './savedStreams.mjs';

const DAY = 86400000;
const digest = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const idValid = value => /^\d+$/.test(String(value ?? ''));
const sorted = rows => [...rows].sort((a, b) => String(a.stream_id ?? a.category_id).localeCompare(String(b.stream_id ?? b.category_id)));

export function validCatalogue(snapshot, scope) {
  return snapshot?.version === 1 && snapshot.scope === scope && Number.isFinite(snapshot.updatedAt) &&
    snapshot.updatedAt > 0 && snapshot.updatedAt <= Date.now() + 60000 &&
    Array.isArray(snapshot.channels) && snapshot.channels.length > 0 && snapshot.channels.length <= 10000 &&
    snapshot.channels.every(c => c && idValid(c.stream_id) && typeof c.name === 'string' && typeof c.category_id === 'string') &&
    new Set(snapshot.channels.map(c => String(c.stream_id))).size === snapshot.channels.length &&
    Array.isArray(snapshot.categories) && snapshot.categories.length <= 10000 &&
    snapshot.categories.every(c => c && typeof c.category_id === 'string' && typeof c.category_name === 'string');
}

// Provider list reads are complete responses. Delta is applied locally by stable
// provider ID. Missing rows survive: a truncated response must not erase channels.
export function mergeCatalogue(previous, channels, categories, creds, now = Date.now()) {
  const scope = accountScope(creds);
  if (previous && (!validCatalogue(previous, scope) || previous.scope !== scope)) throw new Error('Invalid previous catalogue/account');
  if (!scope || !Array.isArray(channels) || !channels.length || channels.length > 10000 ||
      !Array.isArray(categories) || !categories.length || categories.length > 10000) throw new Error('Invalid provider catalogue');
  const rows = new Map((previous?.channels || []).map(c => [String(c.stream_id), c]));
  const groups = new Map((previous?.categories || []).map(c => [c.category_id, c]));
  const sourceHashes = { ...previous?.sourceHashes };
  const seen = new Set();
  const stats = { added: 0, updated: 0, unchanged: 0, retained: 0 };
  for (const c of categories) {
    if (!c || !idValid(c.category_id) || typeof c.category_name !== 'string' || c.category_name.length > 1000) throw new Error('Invalid catalogue category');
    groups.set(String(c.category_id), { category_id: String(c.category_id), category_name: c.category_name });
  }
  for (const c of channels) {
    if (!c || !idValid(c.stream_id) || typeof c.name !== 'string' || !c.name.trim() || c.name.length > 1000) throw new Error('Invalid catalogue channel');
    const id = String(c.stream_id);
    if (seen.has(id)) throw new Error('Duplicate catalogue channel');
    seen.add(id);
    const row = { stream_id: Number(id), name: c.name, stream_icon: typeof c.stream_icon === 'string' ? c.stream_icon.slice(0, 8192) : '', category_id: String(c.category_id ?? '') };
    const hash = digest([publicStreamUrl(c.direct_source) || '', c.custom_sid || '', c.added || '']);
    const old = rows.get(id);
    if (!old) stats.added++;
    else if (JSON.stringify(old) !== JSON.stringify(row) || sourceHashes[id] !== hash) stats.updated++;
    else stats.unchanged++;
    rows.set(id, row);
    sourceHashes[id] = hash;
  }
  stats.retained = [...rows.keys()].filter(id => !seen.has(id)).length;
  if (rows.size > 10000) throw new Error('Catalogue capacity exceeded');
  const snapshot = { version: 1, scope, updatedAt: now, channels: [...rows.values()], categories: [...groups.values()], sourceHashes };
  if (previous && !stats.added && !stats.updated && JSON.stringify(sorted(previous.categories)) === JSON.stringify(sorted(snapshot.categories))) return { snapshot: previous, stats };
  return { snapshot, stats };
}

export async function syncAddresses({ store, channels, catalogue, previousCatalogue, creds, now = Date.now(), observedAt = now, resolve, maxResolve = 0, deadlineAt = Infinity, state = {}, onProgress }) {
  const direct = new Map(snapshotFromCatalogue(channels, creds, observedAt).entries.map(row => [row.id, row]));
  const stats = { changed: 0, kept: 0, attempted: 0, resolved: 0, remaining: 0 };
  const nextState = {};
  for (const channel of channels) {
    const id = String(channel.stream_id);
    const current = await store.get(id);
    const candidate = direct.get(id);
    const sourceChanged = previousCatalogue && catalogue.sourceHashes[id] !== previousCatalogue.sourceHashes?.[id];
    if (current && current.expiresAt > now + DAY && !sourceChanged) { stats.kept++; continue; }
    if (candidate && store.normalize(candidate)?.expiresAt > now + DAY) {
      const changed = await store.merge({ version: 1, scope: store.scope, entries: [candidate] });
      stats.changed += changed;
      if (changed || (await store.get(id))?.expiresAt > now + DAY) continue;
    }
    const previous = state[id];
    if (previous?.hash === catalogue.sourceHashes[id] && previous.retryAt > now) { nextState[id] = previous; stats.remaining++; continue; }
    if (!resolve || stats.attempted >= maxResolve || Date.now() >= deadlineAt) { stats.remaining++; continue; }
    stats.attempted++;
    let result;
    try { result = await resolve(channel, creds); } catch { result = { status: 'unavailable' }; }
    if (result?.status === 'resolved' && await store.remember(id, result.url)) { stats.changed++; stats.resolved++; }
    else { stats.remaining++; nextState[id] = { hash: catalogue.sourceHashes[id], retryAt: now + (result?.status === 'provider_required' ? DAY : 60 * 60 * 1000) }; }
    await onProgress?.({ stats: { ...stats }, state: { ...nextState } });
  }
  return { stats, state: nextState };
}

// Each discovery opens one channel briefly, sequentially, then cancels its body.
// A successful local request is only a candidate for cloud playback: the server
// still validates it at playback and retains the provider fallback.
export async function resolvePublicStream(channel, creds, { request = fetch, timeoutMs = 8000 } = {}) {
  const provider = new URL(creds.server).hostname;
  const routed = (process.env.PROXY_HOSTS || 'snapmediatoghater.site,mctvpal.site').split(',').map(h => h.trim().toLowerCase()).filter(Boolean);
  const requiresProvider = host => host === provider || routed.some(h => host === h || host.endsWith(`.${h}`));
  let target = new URL(`/live/${encodeURIComponent(creds.username)}/${encodeURIComponent(creds.password)}/${channel.stream_id}.ts`, creds.server);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  let response;
  let reader;
  try {
    for (let hop = 0; hop < 6; hop++) {
      if (!publicStreamUrl(target.href)) return { status: 'unavailable' };
      response = await request(target, { redirect: 'manual', signal: controller.signal, headers: { 'User-Agent': 'Mozilla/5.0', Accept: '*/*' } });
      if ([301, 302, 303, 307, 308].includes(response.status)) {
        const location = response.headers.get('location');
        await response.body?.cancel();
        if (!location) return { status: 'unavailable' };
        target = new URL(location, target);
        continue;
      }
      if (!response.ok || /text\/html|application\/json/i.test(response.headers.get('content-type') || '')) return { status: 'unavailable' };
      if (requiresProvider(target.hostname)) return { status: 'provider_required' };
      reader = response.body?.getReader();
      if (!reader) return { status: 'unavailable' };
      const chunks = [];
      let length = 0;
      while (length < 188) {
        const part = await reader.read();
        if (part.done) break;
        chunks.push(part.value.subarray(0, 188 - length));
        length += chunks[chunks.length - 1].length;
      }
      const prefix = Buffer.concat(chunks);
      if (prefix.toString('utf8').trimStart().startsWith('#EXTM3U') || (prefix.length >= 188 && prefix[0] === 0x47)) return { status: 'resolved', url: target.href };
      return { status: 'unavailable' };
    }
    return { status: 'unavailable' };
  } catch { return { status: 'unavailable' }; }
  finally {
    clearTimeout(timer);
    controller.abort();
    if (reader) await reader.cancel().catch(() => {});
    else await response?.body?.cancel().catch(() => {});
  }
}
