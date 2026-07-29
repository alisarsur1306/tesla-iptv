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

## Required: a Tailscale exit node

The Xtream provider sits behind Cloudflare, which **blocks Render's datacenter
IPs**. Without an exit node the app boots and serves the UI, then fails at login
with a Cloudflare "you have been blocked" page. No code change can fix this — the
requests have to leave from a residential IP.

Only the Xtream API host is routed this way. Segments redirect to a CDN that does
*not* block datacenter IPs, and its tokens are not IP-bound, so video streams
direct from Render. Measured: ~3 KB per playlist refresh over the tunnel versus
~2 MB per segment direct — the exit node carries metadata, never the video.

1. Install Tailscale on a device that is always on at home (an Android TV, Pi, or
   NAS all work — it only handles a few KB per refresh).
2. Advertise it as an exit node, and approve it in the Tailscale admin console
   under **Machines → … → Edit route settings → Use as exit node**.
3. Generate a **reusable, ephemeral** auth key (Settings → Keys). Ephemeral means
   the Render node removes itself when the free tier sleeps, instead of piling up
   stale machines.
4. Add two more environment variables in Render:
   - `TS_AUTHKEY` — the auth key from step 3
   - `TS_EXIT_NODE` — the exit node's tailnet name or IP, e.g. `android-tv`

Auth keys expire after at most 90 days. When yours does, the service will start
but log `tailscale failed to come up` and upstream requests will be blocked again
— generate a new key and update `TS_AUTHKEY`. Use an OAuth client with a tag if
you want something that doesn't expire.

Leaving `TS_AUTHKEY` unset skips the whole mechanism: no Tailscale download at
build time, and the app talks to upstream directly. That's the right setting for
local use, where `car-tv-on.bat` already runs from a residential IP.

### Troubleshooting the exit node

Every failure below looks identical from the browser — a Cloudflare "you have
been blocked" page — because whenever the tunnel isn't actually carrying
traffic, requests silently fall back to Render's own (blocked) IP. Check in this
order:

| Symptom in Render logs | Cause | Fix |
|---|---|---|
| `netmap: suggested exit node:  ()` | No **approved** exit node exists — or the approved one is offline | `tailscale exit-node list` on any tailnet machine; a node showing `offline` is the culprit |
| `invalid key: API key … not valid` | An **API access token** was used instead of an **auth key** | Generate under *Auth keys*; the value must start with `tskey-auth-` |
| Works once, fails after the next restart | Auth key is not **Reusable** | Regenerate with Reusable ON — Render's free tier restarts constantly |
| `./tailscaled: not found` / deploy dies, old instance keeps serving | Binaries missing | `fetch-tailscale.sh` now always downloads, so this shouldn't recur |

Two traps worth stating explicitly:

- **Advertising is not approving.** `tailscale set --advertise-exit-node` only
  *offers* the machine. It stays unusable until someone ticks **Use as exit
  node** in the admin console (Machines → ⋯ → Edit route settings). A machine
  never lists *itself* in `tailscale exit-node list`, so check from another
  machine or the console.
- **An offline exit node fails silently.** Tailscale accepts a dead node and
  blackholes through it, and the log line `Tailscale up; routing Xtream host via
  exit node …` is only this script echoing what it *requested* — not proof the
  route works. Trust `tailscale exit-node list`, not that line.

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
