# Deploy to Render (free tier)

The app is a single Node service: `server.js` serves the built frontend from
`dist/` and mounts the `/api/proxy` HLS proxy. No secrets live in the repo —
credentials and the access key are environment variables.

## Steps

1. Push this repo to GitHub (see note below — it may already be there).
2. Go to <https://render.com> and sign in **with GitHub**.
3. Click **New → Blueprint**, pick the `tesla-iptv` repo.
   Render reads `render.yaml` and pre-fills the service.
4. When prompted, fill in the 4 environment variables:
   - `XTREAM_SERVER` — e.g. `http://your-xtream-host:8080`
   - `XTREAM_USERNAME` — your Xtream username
   - `XTREAM_PASSWORD` — your Xtream password
   - `ACCESS_KEY` — any secret string you invent; it gates the proxy so
     strangers can't use your deployment (or your 1-connection account).
5. Deploy. Render runs `npm install && npm run build`, then `node server.js`.

## Required: the Cloudflare Worker

The Xtream provider sits behind Cloudflare, which **blocks Render's datacenter
IPs**. Without a workaround the app boots and serves the UI, then fails at login
with a Cloudflare "you have been blocked" page. Cloudflare does **not** block
requests coming from its own network, so a tiny Cloudflare Worker fetches the
Xtream host and relays the reply.

Only the Xtream API host goes through the Worker. It returns the origin's 3xx
redirect rather than following it, so the CDN hop that carries the actual video
is fetched **directly** from Render — the Worker only ever relays small
redirects and the login JSON, never the stream.

1. Deploy the Worker (free Cloudflare account): see
   [`cloudflare-worker/README.md`](cloudflare-worker/README.md). It prints a URL
   like `https://tesla-iptv-xtream-proxy.<subdomain>.workers.dev`.
2. Add two environment variables in Render:
   - `XTREAM_PROXY_URL` — the Worker URL from `wrangler deploy`
   - `XTREAM_PROXY_TOKEN` — the same token you set with `wrangler secret put PROXY_TOKEN`

Leaving `XTREAM_PROXY_URL` unset skips the Worker and talks to upstream directly
— correct for local use, where `car-tv-on.bat` already runs from a residential
IP, but it will hit the Cloudflare block from Render.

The Cloudflare Worker free tier allows 100,000 requests/day; this uses a tiny
fraction of that (one request per playlist refresh, none for video).

## Using it in the Tesla

- Open `https://<your-app>.onrender.com/?key=<ACCESS_KEY>` **once** in the
  Tesla browser. The key is stored in the browser's localStorage and the
  address bar is cleaned; after that, plain `https://<your-app>.onrender.com`
  keeps working. If the key is ever lost/reset, the app shows an
  "Access key required" prompt after a 403 — enter it and it retries.
- **Free tier sleeps after ~15 min idle.** The first load after sleep takes
  ~30–60 s (cold start) — just wait for it. Playback is unaffected once awake.
- The account allows **1 connection** — don't stream on two devices at once.

## Local dev (unchanged)

`public/config.json` (untracked) keeps credentials for local dev, and with no
`ACCESS_KEY` set everything stays open:

```bash
npm install
npm run dev        # vite dev server, proxy mounted at /api/proxy
# or production-style:
npm run build && npm start   # node server.js on port 7100
```

To mimic the deployment locally:

```bash
ACCESS_KEY=test123 XTREAM_SERVER=http://... XTREAM_USERNAME=... XTREAM_PASSWORD=... node server.js
```
