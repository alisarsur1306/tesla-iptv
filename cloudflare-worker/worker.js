// Cloudflare Worker: re-fetches the Xtream API host from Cloudflare's edge.
//
// Why this exists: the Xtream host sits behind Cloudflare, which blocks requests
// from datacenter IPs (so the Render deploy is refused with a "you have been
// blocked" page). Requests originating from Cloudflare's own network are NOT
// blocked, so a Worker can fetch the host and relay the reply.
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
