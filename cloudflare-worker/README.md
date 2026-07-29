# Xtream proxy Worker

Tiny Cloudflare Worker that re-fetches the Xtream API host from Cloudflare's
edge, so the Render deploy can reach it. The Xtream host blocks datacenter IPs
(Render), but not requests from Cloudflare's own network. This replaces the
Tailscale exit-node setup.

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

Then remove the old Tailscale vars (`TS_AUTHKEY`, `TS_EXIT_NODE`) — they're no
longer used.

## The token

`PROXY_TOKEN` gates the Worker so a leaked URL can't be used to hammer the
Xtream host. It must match `XTREAM_PROXY_TOKEN` on Render. Generate a new one
anytime with:

```bash
node -e "console.log(require('crypto').randomBytes(24).toString('base64url'))"
```
