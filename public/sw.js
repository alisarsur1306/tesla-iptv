// Cache the public application shell only. Account APIs, channel addresses,
// segments, manifests and other live media always keep their normal routing.
const SHELL_CACHE = 'tesla-iptv-shell-v1';
const root = new URL('/', self.location.origin).href;
let refreshing;

function assetUrl(value) {
  const url = new URL(value, root);
  return url.origin === self.location.origin && !url.search && /^\/assets\/[^/]+\.(?:js|css|wasm)$/.test(url.pathname) ? url.href : null;
}

async function refreshShell() {
  if (refreshing) return refreshing;
  refreshing = (async () => {
    const response = await fetch(root, { cache: 'no-cache', signal: AbortSignal.timeout(15000) });
    if (!response.ok || !/text\/html/.test(response.headers.get('content-type') || '')) throw new Error('Shell unavailable');
    const html = await response.clone().text();
    if (!html.includes('name="tesla-shell" content="1"')) throw new Error('Not an application shell');
    const assets = [...html.matchAll(/(?:src|href)="([^\"]+)"/g)].map(match => assetUrl(match[1])).filter(Boolean);
    if (!assets.length) throw new Error('No shell assets');
    const cache = await caches.open(SHELL_CACHE);
    for (const url of assets) {
      if (await cache.match(url)) continue;
      const asset = await fetch(url, { signal: AbortSignal.timeout(15000) });
      if (!asset.ok) throw new Error('Shell asset unavailable');
      await cache.put(url, asset);
    }
    // Swap the HTML only when all referenced scripts/styles are available.
    await cache.put(root, response.clone());
    const keys = await cache.keys();
    const removable = keys.filter(req => req.url !== root && !assets.includes(req.url));
    for (const req of removable.slice(0, Math.max(0, keys.length - 100))) await cache.delete(req);
    return response;
  })().finally(() => { refreshing = null; });
  return refreshing;
}

self.addEventListener('install', event => event.waitUntil(refreshShell().then(() => self.skipWaiting())));
self.addEventListener('activate', event => event.waitUntil(self.clients.claim()));
self.addEventListener('fetch', event => {
  const request = event.request;
  const url = new URL(request.url);
  if (request.method !== 'GET' || url.origin !== self.location.origin) return;
  if (request.mode === 'navigate' && (url.pathname === '/' || url.pathname === '/index.html')) {
    // The normalized cache key never contains the access key from navigation.
    const update = refreshShell();
    event.waitUntil(update.catch(() => {}));
    event.respondWith((async () => {
      try {
        const cached = await (await caches.open(SHELL_CACHE)).match(root);
        if (cached) return cached;
      } catch { /* Storage disabled: keep normal online navigation. */ }
      try { return await update; } catch { return fetch(request); }
    })());
    return;
  }
  const asset = assetUrl(url.href);
  if (!asset) return;
  event.respondWith((async () => {
    let cache;
    try {
      cache = await caches.open(SHELL_CACHE);
      const cached = await cache.match(asset);
      if (cached) return cached;
    } catch { /* The online app still works without Cache Storage. */ }
    const response = await fetch(request);
    if (response.ok && cache) { try { await cache.put(asset, response.clone()); } catch { /* Quota full. */ } }
    return response;
  })());
});
