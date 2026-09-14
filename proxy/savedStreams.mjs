import { createHash } from 'node:crypto';
import { isIP } from 'node:net';
import { promises as fs } from 'node:fs';
import path from 'node:path';

const WEEK = 7 * 24 * 60 * 60 * 1000;
export const MAX_SNAPSHOT_BYTES = 8 * 1024 * 1024;

export function accountScope(creds) {
  if (!creds?.server || !creds.username || !creds.password) return null;
  return createHash('sha256').update(JSON.stringify([
    String(creds.server).replace(/\/+$/, ''), String(creds.username), String(creds.password),
  ])).digest('hex');
}

export function publicStreamUrl(value) {
  if (typeof value !== 'string' || value.length > 8192) return null;
  try {
    const url = new URL(value);
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) return null;
    const host = url.hostname.toLowerCase().replace(/^\[|\]$/g, '').replace(/\.$/, '');
    if (isIP(host) === 4) {
      const [a, b] = host.split('.').map(Number);
      if (a === 0 || a === 10 || a === 127 || a >= 224 || (a === 100 && b >= 64 && b <= 127) ||
          (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) ||
          (a === 192 && (b === 168 || b === 0)) || (a === 198 && (b === 18 || b === 19))) return null;
    } else if (isIP(host) === 6) {
      // Only global unicast literals; excludes local, mapped IPv4 and link-local.
      if (!/^[23][0-9a-f]{3}:/.test(host)) return null;
    } else if (!host.includes('.') || /(?:^|\.)(?:localhost|local|internal|invalid)$/.test(host)) return null;
    url.hash = '';
    return url.href;
  } catch { return null; }
}

function knownExpiry(url) {
  let expiry = Infinity;
  for (const [key, raw] of new URL(url).searchParams) {
    if (!/^(?:expires|exp|expiry)$/i.test(key) || !/^\d{10,13}$/.test(raw)) continue;
    const value = Number(raw);
    expiry = Math.min(expiry, value < 1e12 ? value * 1000 : value);
  }
  return expiry;
}

export class SavedStreams {
  constructor({ directory, scope, now = Date.now, ttlMs = WEEK, maxEntries = 10000 }) {
    if (!/^[a-f0-9]{64}$/.test(scope || '')) throw new Error('Invalid cache account');
    this.scope = scope;
    this.file = path.join(directory, `stream-addresses-${scope}.json`);
    this.now = now;
    this.ttlMs = Math.min(30 * 24 * 60 * 60 * 1000, Math.max(1000, ttlMs));
    this.maxEntries = Math.min(10000, Math.max(1, maxEntries));
    this.entries = new Map();
    this.pending = Promise.resolve();
  }

  normalize(row) {
    if (!row || !/^\d+$/.test(String(row.id ?? ''))) return null;
    const url = publicStreamUrl(row.url);
    if (!url || !Number.isFinite(row.savedAt) || row.savedAt <= 0 || row.savedAt > this.now() + 60000) return null;
    const expiresAt = Math.min(row.savedAt + this.ttlMs, knownExpiry(url), Number.isFinite(row.expiresAt) ? row.expiresAt : Infinity);
    const result = { id: String(row.id), url, savedAt: row.savedAt, expiresAt };
    if (Number.isFinite(row.failedAt)) result.failedAt = row.failedAt;
    return result;
  }

  accept(snapshot) {
    if (snapshot?.version !== 1 || snapshot.scope !== this.scope || !Array.isArray(snapshot.entries) || snapshot.entries.length > 10000) return 0;
    let accepted = 0;
    for (const input of snapshot.entries) {
      const row = this.normalize(input);
      if (!row) continue;
      const current = this.entries.get(row.id);
      if (current && (current.savedAt > row.savedAt || (current.url === row.url && current.failedAt >= row.savedAt))) continue;
      this.entries.set(row.id, row);
      accepted++;
    }
    if (this.entries.size > this.maxEntries) {
      const oldest = [...this.entries.values()].sort((a, b) => a.savedAt - b.savedAt);
      for (const row of oldest.slice(0, this.entries.size - this.maxEntries)) this.entries.delete(row.id);
    }
    return accepted;
  }

  async load() {
    this.loading ||= (async () => {
      try {
        if ((await fs.stat(this.file)).size > MAX_SNAPSHOT_BYTES) return;
        this.accept(JSON.parse(await fs.readFile(this.file, 'utf8')));
      } catch { /* Absent/corrupt private storage is a cache miss. */ }
    })();
    await this.loading;
  }

  async get(id) {
    await this.load();
    const row = this.entries.get(String(id));
    return row && row.expiresAt > this.now() && !(row.failedAt >= row.savedAt) ? { ...row } : null;
  }

  async snapshot() {
    await this.load();
    return { version: 1, scope: this.scope, entries: [...this.entries.values()].map(row => ({ ...row })) };
  }

  persist() {
    const data = JSON.stringify({ version: 1, scope: this.scope, entries: [...this.entries.values()] });
    this.pending = this.pending.then(async () => {
      if (Buffer.byteLength(data) > MAX_SNAPSHOT_BYTES) return;
      await fs.mkdir(path.dirname(this.file), { recursive: true, mode: 0o700 });
      const temp = `${this.file}.tmp`;
      await fs.writeFile(temp, data, { mode: 0o600 });
      await fs.rename(temp, this.file);
    }).catch(() => { /* Persistence failure does not interrupt live video. */ });
  }

  async remember(id, url) {
    await this.load();
    const row = this.normalize({ id, url, savedAt: this.now() });
    if (!row || row.expiresAt <= this.now()) return false;
    this.accept({ version: 1, scope: this.scope, entries: [row] });
    this.persist();
    return true;
  }

  async merge(snapshot) {
    await this.load();
    const accepted = this.accept(snapshot);
    if (accepted) this.persist();
    return accepted;
  }

  async invalidate(id, url) {
    await this.load();
    const row = this.entries.get(String(id));
    if (row?.url !== url) return;
    row.failedAt = this.now();
    this.persist();
  }

  flush() { return this.pending; }
}

// Reuse the existing read-only backup credential only inside its own HTTPS
// GitHub Contents directory. Never forward that credential through a redirect.
export function sidecarSource(env = process.env) {
  try {
    const url = new URL(env.M3U_URL);
    if (url.origin !== 'https://api.github.com' || !/^\/repos\/[^/]+\/[^/]+\/contents\/.+/.test(url.pathname) || url.username || url.password) return null;
    url.pathname = url.pathname.replace(/[^/]+$/, 'resolved-streams.json');
    const headers = { Accept: 'application/vnd.github.raw+json' };
    if (env.M3U_AUTH) headers.Authorization = env.M3U_AUTH;
    return { url: url.href, headers };
  } catch { return null; }
}

export function snapshotFromCatalogue(channels, creds, now = Date.now()) {
  const provider = new URL(creds.server).hostname;
  const entries = [];
  for (const channel of channels) {
    const url = publicStreamUrl(channel.direct_source);
    if (!url || new URL(url).hostname === provider || !/^\d+$/.test(String(channel.stream_id))) continue;
    entries.push({ id: String(channel.stream_id), url, savedAt: now });
  }
  return { version: 1, scope: accountScope(creds), entries };
}
