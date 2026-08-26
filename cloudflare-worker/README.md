# Xtream proxy Worker

Tiny Cloudflare Worker that re-fetches the Xtream API host from Cloudflare's
edge, so the Render deploy can reach it. The Xtream host blocks datacenter IPs
(Render), but not requests from Cloudflare's own network.

This is an *alternative* to the Tailscale exit node, not a replacement: the app
supports both transports and prefers the Worker when `XTREAM_PROXY_URL` is set,
because the Worker needs no always-on hardware at home. Leaving the `TS_*` vars
in place costs nothing and keeps the tunnel one env var away if the Worker turns
out not to work.

Only the Xtream host is proxied, and only the small API/playlist requests —
video segments still stream directly from Render. See `../DEPLOY.md`.

## Deploy (free tier, ~5 minutes)

You need a free Cloudflare account. From this folder:

```bash
npm install -g wrangler        # once
wrangler login                 # opens a browser to authorize
wrangler secret put PROXY_TOKEN   # paste the token below when prompted
wrangler deploy
```

`wrangler deploy` prints the Worker URL, e.g.
`https://tesla-iptv-xtream-proxy.<your-subdomain>.workers.dev`.

## Wire it to Render

In the Render dashboard → `tesla-iptv` → Environment, set:

- `XTREAM_PROXY_URL` = the Worker URL from `wrangler deploy`
- `XTREAM_PROXY_TOKEN` = the same token you gave `wrangler secret put`

Leave `TS_AUTHKEY` / `TS_EXIT_NODE` alone. While `XTREAM_PROXY_URL` is set the
Worker takes precedence and the tunnel is unused; unset it and the app falls
straight back to Tailscale, with no redeploy of anything but the env var.

## Did it work?

The bypass this Worker relies on has never been confirmed against the live
origin — it was measured indirectly (a Cloudflare-IP proxy reached the host
while 1006 non-Cloudflare proxies failed) and verified locally against a stub.
After deploying, check it in one request:

```bash
curl -sS "https://<your-app>.onrender.com/api/xt?action=get_live_streams&key=<ACCESS_KEY>" | head -c 200
```

A channel list means the edge bypass is real. A `Channel list failed` with a
Cloudflare block page behind it means it is not, and the residential-proxy route
(`UPSTREAM_PROXY`) is the remaining option that needs no hardware at home.

## The token

`PROXY_TOKEN` gates the Worker so a leaked URL can't be used to hammer the
Xtream host. It must match `XTREAM_PROXY_TOKEN` on Render. Generate a new one
anytime with:

```bash
node -e "console.log(require('crypto').randomBytes(24).toString('base64url'))"
```
