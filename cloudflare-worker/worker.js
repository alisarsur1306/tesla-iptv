// Cloudflare Worker: re-fetches the Xtream API host from Cloudflare's edge.
//
// Why this exists: the Xtream host sits behind Cloudflare, which blocks requests
// from datacenter IPs (so the Render deploy is refused with a "you have been
// blocked" page). A Worker's request is accepted only when the Worker itself was
// called from a home or mobile connection (see resolveStream below); relaying for
// the app server does not work.
//
// It is deliberately NOT a general proxy:
//   - only the Xtream host (snapmediatoghater.site + subdomains) is allowed;
//   - a shared token (PROXY_TOKEN) gates it so a leaked URL can't be abused;
//   - redirects are returned, not followed — the Render server follows the CDN
//     hop directly, so this Worker only ever relays small redirects and JSON,
//     never the video.
//
// Deploy: see README.md in this folder.

const ALLOWED_SUFFIX = 'snapmediatoghater.site';

function allowedHost(hostname) {
  const h = hostname.toLowerCase();
  return h === ALLOWED_SUFFIX || h.endsWith('.' + ALLOWED_SUFFIX);
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const target = url.searchParams.get('u');
    const token = url.searchParams.get('t') || '';

    if (env.PROXY_TOKEN && token !== env.PROXY_TOKEN) {
      return new Response('Forbidden', { status: 403 });
    }
    const resolveId = url.searchParams.get('resolve');
    if (resolveId !== null) return resolveStream(resolveId, env, request);
    if (!target) return new Response('Missing "u"', { status: 400 });

    let t;
    try {
      t = new URL(target);
    } catch {
      return new Response('Invalid "u"', { status: 400 });
    }
    if (t.protocol !== 'http:' && t.protocol !== 'https:') {
      return new Response('Only http/https', { status: 400 });
    }
    if (!allowedHost(t.hostname)) {
      return new Response('Host not allowed', { status: 403 });
    }

    let upstream;
    try {
      upstream = await fetch(t.toString(), {
        method: 'GET',
        headers: {
          'User-Agent': request.headers.get('user-agent') || 'Mozilla/5.0',
          Accept: '*/*',
        },
        // Return the origin's redirect; the caller follows the CDN hop directly.
        redirect: 'manual',
      });
    } catch (err) {
      return new Response('Upstream fetch failed: ' + err, { status: 502 });
    }

    // Relay status + the headers the caller needs (Location for redirects,
    // Content-Type for bodies). Everything else is dropped.
    const headers = new Headers();
    const ct = upstream.headers.get('content-type');
    if (ct) headers.set('content-type', ct);
    const loc = upstream.headers.get('location');
    if (loc) headers.set('location', loc);
    headers.set('access-control-allow-origin', '*');

    return new Response(upstream.body, { status: upstream.status, headers });
  },
};

// ?resolve=<channel id>: look up one channel's video address and hand it to the app server.
//
// Measured 2026-11: the provider's Cloudflare rules judge the ORIGINAL caller of the Worker.
// Called by the app server (a datacenter) the lookup is refused; called from a home or mobile
// browser it is accepted. So the player's browser calls this (the app server redirects it
// here), and the address is posted to the app server directly: the browser only learns
// ok / not ok, never the address, which carries the account.
//
// Secrets: XTREAM_SERVER, XTREAM_USERNAME, XTREAM_PASSWORD, and LEARN_URL, the app's
// /api/learn URL including its access key.
async function resolveStream(id, env, request) {
  const headers = { 'access-control-allow-origin': '*', 'cache-control': 'no-store' };
  if (!/^\d+$/.test(id) || !env.XTREAM_SERVER || !env.LEARN_URL) {
    return Response.json({ ok: false }, { status: 400, headers });
  }
  const target = `${env.XTREAM_SERVER.replace(/\/+$/, '')}/live/${encodeURIComponent(env.XTREAM_USERNAME)}/${encodeURIComponent(env.XTREAM_PASSWORD)}/${id}.ts`;
  let status = 0;
  let location = null;
  try {
    const upstream = await fetch(target, {
      headers: { 'User-Agent': request.headers.get('user-agent') || 'Mozilla/5.0', Accept: '*/*' },
      redirect: 'manual',
    });
    status = upstream.status;
    location = upstream.headers.get('location');
  } catch {
    /* reported as ok: false */
  }
  if (!location) return Response.json({ ok: false, status }, { headers });

  const learn = new URL(env.LEARN_URL);
  learn.searchParams.set('id', id);
  learn.searchParams.set('u', new URL(location, target).href);
  const saved = await fetch(learn, { method: 'POST' }).then((r) => r.ok, () => false);
  return Response.json({ ok: saved }, { headers });
}
