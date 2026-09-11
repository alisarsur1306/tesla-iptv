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
5. Deploy. Render runs `npm ci && npm run check && ./fetch-tailscale.sh`,
   then `./render-start.sh` to configure Tailscale when requested and start Node.
   `npm run check` runs lint, all isolated tests and the production build. GitHub Actions
   repeats this on pull requests and main. Set Auto-Deploy to **After CI Checks Pass**
   in an existing Render service (new Blueprints use `autoDeployTrigger: checksPass`).

## Reaching the Xtream host from a datacenter

The Xtream provider sits behind Cloudflare, which **blocks Render's datacenter
IPs**. Without a way around that, the app boots and serves the UI, then fails at
login with a Cloudflare "you have been blocked" page. There are three ways to
give it a non-blocked path; the app supports all three and picks in this order:

| Env var | Route | Needs |
| --- | --- | --- |
| `XTREAM_PROXY_URL` | A Cloudflare Worker re-fetches the host; provider acceptance must be verified | A Cloudflare account with the Worker deployed. No home hardware. |
| `UPSTREAM_PROXY` | An HTTP proxy borrows a non-datacenter IP — a Tailscale exit node at home, or a commercial residential proxy | An always-on device, or a few $/month |
| *(neither set)* | Provider requests blocked on Render; direct in local development | Configure a proxy on Render |

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

The hostname from the configured Xtream account is always routed, even when it
is absent from the legacy domain list. `PROXY_HOSTS` supplies additional provider
or image-host suffixes. Redirects re-check routing on each hop.

On Render, a missing proxy now fails closed for those hosts: the app reports the
missing configuration instead of contacting the provider from its cloud IP.
This uses Render's documented [`RENDER=true` environment variable](https://render.com/docs/environment-variables).
A configured proxy that fails is not retried directly. This guard does not check
where the proxy itself exits; a VPN on the home device still requires separate
diagnosis below. Unlisted CDN hosts continue to use direct transport.

Unlisted CDN hosts are fetched directly from Render. This depends on those
hosts accepting cloud requests and their stream tokens working across IPs;
the app cannot guarantee either property for a changed provider or redirect.
Add a provider-owned hostname to `PROXY_HOSTS` if it must also take the proxy
route, bearing in mind that this may route video through the home connection.

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

An expired or invalid auth key makes `tailscale up` fail. The startup script
exits before starting Node, so a new deployment cannot become healthy. Renew
the configured authentication as appropriate in Tailscale and update
`TS_AUTHKEY`; do not treat a previous live instance as proof the new one started.

Leaving `TS_AUTHKEY` unset skips starting Tailscale. Binaries are still downloaded
at build time so enabling it later does not require another build. The app then
uses a configured Worker or `UPSTREAM_PROXY`; with neither, provider requests
are blocked on Render and may go direct in local development.

### Troubleshooting the exit node

Distinguish a provider refusal (403) from a tunnel connection failure or timeout.
A configured tunnel has no automatic direct retry. A missing proxy is now
explicitly blocked on Render rather than silently using its IP. Check in this order:

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
- **Startup is not a forwarding test.** Tailscale may accept the requested
  configuration while the exit node cannot forward traffic. The startup log
  now says the node is configured, not that its egress was verified. Check
  `/api/health` and the exit node's online/routing state.

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

## A VPN on the exit node silently undoes the tunnel

The tunnel exists for one reason: to make requests leave from a residential IP, because the
provider's Cloudflare rules refuse datacenter ones. Anything that changes where the exit node's
traffic leaves from therefore breaks the whole arrangement — and a corporate VPN on that machine
does exactly that.

It is hard to spot because the machine itself keeps working. The exit node forwards traffic on
behalf of other devices, and that forwarded path is separate from the host's own connections: a
`curl` from the Mac can reach the provider perfectly while everything Render routes through it
is dropped or leaves from the VPN's datacenter address. "It works when I test it here" and "the
app gets nothing" are both true at once.

The symptom is a timeout with no refusal and no reset — indistinguishable, from the outside,
from a dead exit node, an asleep machine, or an exhausted connection limit. All of those were
investigated before the VPN was.

`GET /api/diag?key=<ACCESS_KEY>&quick=1` reports `egressTransport` and `egressIp`.
The IP-check request uses the provider's selected transport: Worker takes
priority over tunnel, direct mode stays direct, and blocked mode makes no
IP-check request. It never substitutes a tunnel measurement for a Worker route.

Compare a tunnel result with the expected home connection and check the exit
node's VPN/routing state. An address alone does not establish residential
ownership, provider acceptance or the path used for another hostname.
`null` with `egressIpError` means the measurement failed, not necessarily that
forwarding is down: the supplied Worker restricts target hosts and does not
allow `api.ipify.org`, for example. The live login check below tests provider
acceptance independently.

## Connection check in the player

`GET /api/health?key=<ACCESS_KEY>` performs one small Xtream login request, with
a 10-second deadline that includes reading the response body. Parallel checks
share the same request and its result is cached for 15 seconds. It does not
download video or channel lists and does not use a successful cached list as
evidence that the provider is reachable now.

The response is only `{ status, route, checkedAt }`. It contains no account,
upstream URL, body, or IP. It follows the `/config.json` access-key rule: a
configured key is required; open local mode remains available. The player
interprets these states:

- `ok`: a complete login reply has `auth: 1` and `status: "Active"`.
- `provider_rejected`: the upstream path returned 401, 403 or 429, or the
  account reply refused authentication/reported an inactive account. This
  does not identify whether an HTTP refusal was an IP rule or a proxy gate.
- `proxy_unreachable`: a request through the configured proxy failed before
  a usable response; check both the proxy and its onward connection.
- `timeout`: the whole check exceeded its deadline or the connection timed out.
- `not_configured`: account settings are missing/invalid or Render has no
  configured transport for the provider.
- `unknown`: a response cannot validate login, the upstream returned another
  error, a direct request failed, or only an M3U source is configured.

`route` describes the selected provider transport, not proof of home egress.
An `ok` login does not prove that a specific channel plays or that redirects
use the same network path. `/api/health` is a user-triggered provider diagnosis;
use a static app endpoint for hosting liveness checks to avoid coupling process
restarts to a provider outage.

## When it fails: find out why in one request

Every upstream failure looks the same from the browser — "Channel list failed" —
whether the cause is a Cloudflare block, a dead exit node, a slow list, or a
missing environment variable. `/api/diag` tells them apart:

```
https://<your-app>.onrender.com/api/diag?key=<ACCESS_KEY>
```

It reports which source and transport are in play, which env vars are set (as
booleans — never their values), what is cached and how old it is, and then
probes each upstream live, bypassing the cache, with status, timing and the
first 200 characters of the reply. A Cloudflare interstitial, an Xtream error
and a timeout are then obvious at a glance.

Read it like this:

- `transport: "tunnel"` with a 403 whose preview says Cloudflare → the response
  refused the request. Check the exit node's actual egress and VPN state; the
  status alone does not prove that the request went directly from Render.
- `transport: "blocked"` → neither proxy transport is configured on Render;
  restore it. No direct provider request was made.
- `transport: "direct"` → local direct mode, or a host outside the provider
  routing set. Check the configured account hostname and `PROXY_HOSTS`.
- `player_api login` fine but `get_live_streams` slow or timing out → the list is
  simply big and slow; that is what the cache and `LIST_TIMEOUT_MS` are for.
- Every Xtream check failing while `m3u fallback` is `ok` → the backup is doing
  its job; the channel list you see is coming from it.

The account is redacted out of every preview, and the endpoint refuses to run
unless `ACCESS_KEY` is configured.

## Making the offline backup

**The exported playlist contains your account.** Every line carries a stream URL with the
username and password in it, which is why `public/playlist.m3u` is gitignored and why this
repository — which is public — must never contain it. Host it somewhere private instead.

1. Export it from the running server (it can reach Xtream through the exit node):

       curl -fL -o playlist.m3u "https://<app>/api/export.m3u?key=<ACCESS_KEY>"

2. Put that file in a **private** store. A private GitHub repo works and needs no extra
   service — commit `playlist.m3u` to one, then create a fine-grained personal access token
   limited to that repository with **Contents: read-only**.

3. Point the server at it, using the contents API URL (not the web URL):

       M3U_URL=https://api.github.com/repos/<owner>/<repo>/contents/playlist.m3u
       M3U_AUTH=Bearer github_pat_...

   `M3U_AUTH` is sent verbatim as the `Authorization` header, so `Basic <base64>` works just
   as well for any other private host. The request offers `application/vnd.github.raw`, so a
   contents URL returns the file rather than its JSON metadata.

`/api/diag` reports `M3U_AUTH` as a boolean — it never echoes the token. A 401 or 403 is
reported as the token being rejected; note that GitHub answers **404** for a repository the
token cannot see, so a 404 with `M3U_AUTH` set usually means the token's scope, not the path.

Refresh the backup by re-running step 1 and committing the new file whenever your channel
lineup changes.


Lists also persist in `CACHE_DIR` (the system temp directory by default).
Those files can survive a process restart, but are not guaranteed to survive
a new Render container or deployment. A privately hosted `M3U_URL` remains
the backup for a container without a usable saved list.

The server can now produce that file itself (it reaches Xtream through the exit
node), so no second machine is involved:

1. With `ACCESS_KEY` set, open in any browser and save the file:

   ```
   https://<your-app>.onrender.com/api/export.m3u?key=<ACCESS_KEY>
   ```

   It returns the live channel list as a plain M3U — names, logos, category
   names, and one credentialed stream URL per channel.

2. Host it somewhere Render can fetch, and set `M3U_URL` to that URL.
3. Re-export whenever your provider's channel lineup changes.

**Treat both the export URL and the hosted file as passwords.** Every line
contains your Xtream username and password, which is why the endpoint refuses to
run at all unless `ACCESS_KEY` is configured, and why the playlist must never be
committed to this repo — it is public, and anything under `public/` is copied
into `dist/` at build time and served without a key.

Once `M3U_URL` is set, Xtream stays primary and this is only reached when Xtream
fails. To fall straight to the backup instead, clear `XTREAM_SERVER`.

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
