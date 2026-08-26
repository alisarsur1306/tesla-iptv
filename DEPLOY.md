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

## Reaching the Xtream host from a datacenter

The Xtream provider sits behind Cloudflare, which **blocks Render's datacenter
IPs**. Without a way around that, the app boots and serves the UI, then fails at
login with a Cloudflare "you have been blocked" page. There are three ways to
give it a non-blocked path; the app supports all three and picks in this order:

| Env var | Route | Needs |
| --- | --- | --- |
| `XTREAM_PROXY_URL` | A Cloudflare Worker re-fetches the host from Cloudflare's own network, which the origin does not block | A free Cloudflare account. No hardware. |
| `UPSTREAM_PROXY` | An HTTP proxy borrows a non-datacenter IP — a Tailscale exit node at home, or a commercial residential proxy | An always-on device, or a few $/month |
| *(neither set)* | Direct from Render | Only works if the origin stops blocking |

`XTREAM_PROXY_URL` wins when both are set, so you can leave the Tailscale vars
configured while testing the Worker and fall back by clearing one variable.

**The Worker** — see `cloudflare-worker/README.md`. Deploy it, then set
`XTREAM_PROXY_URL` and `XTREAM_PROXY_TOKEN` in Render. Note its central claim
(that Cloudflare's edge is not blocked) has never been confirmed against the
live origin; the README says how to check in one request.

**A commercial residential proxy** needs no code and no hardware — set

```
UPSTREAM_PROXY=http://user:pass@proxy-host:port
```

Credentials in that URL are honoured (undici's `ProxyAgent` turns them into a
`proxy-authorization` header). Clear `TS_AUTHKEY` so the start script skips
Tailscale and leaves your `UPSTREAM_PROXY` value alone.

Either way, only the Xtream API host is routed. Segments redirect to a CDN that
does *not* block datacenter IPs, and its tokens are not IP-bound, so video
streams direct from Render — the detour carries metadata, never the video.

## Option: a Tailscale exit node

This routes the Xtream host out through a device at home, so the requests leave
from a residential IP. Measured: ~3 KB per playlist refresh over the tunnel
versus ~2 MB per segment direct — the exit node carries metadata, never the
video. Skip this section if you are using `XTREAM_PROXY_URL` or a commercial
residential proxy instead.

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

## When the channel list is slow or Xtream is down

The channel list is the one big download the app makes (megabytes of JSON,
pulled through the exit node). Three things keep it from stranding the car:

- **Cached for 30 minutes.** The first request pays for the download; every
  page load inside that window is answered from memory, and concurrent requests
  share a single upstream fetch instead of each starting their own.
- **A 90 s budget.** List downloads get their own timeout, separate from the
  25 s connect timeout used for playback, because a slow list is still a usable
  list. Streaming behaviour is unchanged.
- **A playlist fallback.** When Xtream fails outright, the last list it served
  is reused; if there isn't one, the app serves an M3U channel list instead —
  `M3U_URL` if set, else `public/playlist.m3u`. Channels then play from the
  playlist's own URLs, so a fallback list is playable, not just visible. To get
  that safety net on Render, set `M3U_URL`: `public/playlist.m3u` is untracked
  (like `config.json`), so it only exists in local dev. With no M3U source at
  all, a hard Xtream failure still returns an error.

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
