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
| `UPSTREAM_PROXY` | An HTTP proxy, such as a Tailscale exit node at home or a commercial residential proxy; verify its actual egress and provider access | An always-on device, or a few $/month |
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

This routes requests for configured provider hosts through a device at home.
They use that device's forwarding path, whose actual egress must be verified.
The tunnel can carry both metadata and video: a continuous MPEG-TS response
served by a routed provider host stays on the tunnel. Each redirect selects
its route again; an unlisted CDN host uses direct transport. Skip this section
if you are using `XTREAM_PROXY_URL` or a commercial residential proxy instead.

1. Install Tailscale on a device that is always on at home, with forwarding
   capacity and home upload bandwidth for any video sent through it.
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

The build pins Tailscale 1.102.4. This includes the 1.102.1 fix for userspace
connections to dual-stack names through an IPv4-only exit node; see the
[official changelog](https://tailscale.com/changelog#2026-08-03).
`TS_VERSION` overrides the build pin when a rollback is needed and requires a
new build. Updating the client does not prove the exit node's DNS works.

### Troubleshooting the exit node

After Tailscale starts, `render-start.sh` launches best-effort `[tunnel-check]`
probes in the background while Node starts: one TSMP ping (hard limit 5 seconds), numeric IPv4
HTTP through the configured local proxy (10 seconds), then an HTTP hostname
probe (10 seconds) only if the numeric request received an HTTP response.
It then reads and parses private node status (3 seconds) and queries the selected exit
node's numeric PeerAPI DNS endpoint through the same proxy (8 seconds).
These checks do not delay cold starts. Failures never trigger a direct request. Logs contain
only fixed outcome labels, HTTP status and command exit codes; bodies, egress IP,
credentials and full Tailscale output are suppressed.

`tsmp=reachable` confirms WireGuard peer communication, not exit forwarding.
If numeric HTTP has no response, destination DNS was not needed for that failed
request. If numeric HTTP responds but hostname HTTP does not, DNS or dual-stack
dialing becomes a candidate alongside destination-specific failure. HTTP errors
also count as responses and may come from the proxy; neither probe proves home
egress or working IPTV. See [Tailscale ping types](https://tailscale.com/kb/1465/ping-types)
and the [curl timeout/proxy options](https://curl.se/docs/manpage.html).

`peer_dns=response http=500` points toward the exit node's DNS handler failing
to resolve the test name; `peer_dns=no_response` points toward its listener or
network path. A 200 is only an HTTP response, not proof of a valid DNS answer.
Missing or invalid peer metadata skips this probe. On macOS, the exit-node DNS
handler reads the first nameserver in `/etc/resolv.conf` and forwards over TCP.
Check that resolver after disconnecting another VPN; do not assume that an
earlier VPN session caused the failure. Render's `--accept-dns=false` does not
bypass this exit-node DNS path. See the
[exit-node resolver implementation](https://github.com/tailscale/tailscale/blob/v1.102.3/net/dns/resolver/tsdns.go#L443-L505)
and [PeerAPI handler](https://github.com/tailscale/tailscale/blob/v1.102.3/ipn/ipnlocal/peerapi.go#L708-L765).

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
  configuration while the exit node cannot forward traffic. Both Render and
  the home device can appear connected in Tailscale while forwarded requests
  time out. The startup log says the node is configured, not that its egress
  was verified. Check `/api/health` and the selected-route diagnostic probes
  alongside the exit node's online/routing state.

## When the channel list is slow or Xtream is down

The channel list is a large metadata download (megabytes of JSON, fetched
through the selected provider route). Three things keep it from stranding the car:

- **Cached for 30 minutes.** The first request pays for the download; every
  page load inside that window is answered from memory, and concurrent requests
  share a single upstream fetch instead of each starting their own.
- **A 90 s budget.** List downloads keep their own timeout. Playback has a
  separate 60-second startup budget that includes backup discovery, all provider
  attempts and the first bytes or complete HLS manifest; each connect attempt
  gets at most 25 seconds within that total.
- **A playlist fallback.** When Xtream fails outright, the last list it served
  is reused; if there isn't one, the app serves an M3U channel list instead —
  `M3U_URL` if set, else `public/playlist.m3u`. Channels then play from the
  playlist's own URLs; the backup preserves the catalogue and playback targets,
  but does not establish that those URLs are reachable. To configure that
  fallback on Render, set `M3U_URL`: `public/playlist.m3u` is untracked
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

### Playback deadlines and failures

After startup, a pending upstream read times out after 20 seconds without
nonempty data. A healthy continuous stream has no fixed duration limit, and
downstream backpressure does not spend the network inactivity budget. Failed
attempts, timed-out refusal bodies and abandoned backup lookups are aborted
before another candidate starts. HLS manifests are limited to 2 MiB.

`/api/stream` startup errors return a fixed safe sentence with `code` and
`retryable`, never a raw upstream URL or error body. `STREAM_TIMEOUT` uses HTTP
504; `STREAM_NOT_CONFIGURED` uses 503; `STREAM_PROXY_UNAVAILABLE`,
`STREAM_REJECTED`, `STREAM_UNAVAILABLE` and `STREAM_INVALID_RESPONSE` use 502.
The client uses `retryable` to distinguish recovery from an action the user
needs to take. Once streaming headers are sent, inactivity closes the stream;
error JSON is never inserted into media bytes.

The browser allows 75 seconds for startup and 20 seconds for subsequent byte
reads. This leaves time for the server's complete startup result to arrive.
These bounds prevent silent loading; they do not restore an offline exit node.

The stream probe in `/api/diag` has a 15-second budget that starts before
resolving a backup, and cold backup resolution gets at most 8 seconds. Quick
diagnostics share a 30-second budget across probes. A recognized first chunk
is reported as initial stream bytes, not proof of decoded playback. The probe
opens a real stream, so avoid running it concurrently with playback on a
single-connection account.

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

### When the channels are listed but none of them play

Listing a channel and playing it are different requests — a different URL shape,
a different id space, and a body that has to be MPEG-TS rather than JSON — so a
list that loads proves nothing about playback. The `live stream <id>` check
covers that half. It runs with the rest, on a channel taken from whatever list
the server already holds; name one explicitly with `&stream=<id>`:

```
https://<your-app>.onrender.com/api/diag?key=<ACCESS_KEY>&stream=12345
```

Read it like this:

- `looksLike: "mpeg-ts"` → the probe received initial MPEG-TS bytes; it did not
  verify decoding or sustained playback. `servedByHost` identifies the final
  response host, while `transport` describes the requested host's selected
  route. A hostname alone does not prove tunnel use or residential egress:
  Worker priority and routing checks on redirects still apply.
- `status: 403` → access was refused; this can be an account, provider or proxy
  rule. Compare the selected-route probes and expected egress rather than
  inferring the path from the status. A refusal the server judges genuine is
  remembered only after the available candidates fail without a retryable
  outcome. The grid says "Source previously refused this channel";
  `/api/unavailable` lists those records. This is not proof that the channel
  is excluded from the subscription.
- `looksLike: "html"` → something upstream answered instead of the provider (a
  block page or a captive portal), whatever the status says.
- `idSpace` → which of the two id spaces the id was resolved in. The player is
  served by the backend, which can try an alternate target when the first
  fails. This supports cached IDs from either source; the selected target
  still needs to accept the request and deliver playable media.

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

### Saved video addresses and a one-time local refresh

The server first tries a saved public video address for the requested channel.
It learns addresses from refreshed catalogues and successful direct playback, and can import a private
`resolved-streams.json` file beside a GitHub-hosted `M3U_URL`. This file is bound
to the exact provider account; changing its server, username or password prevents
reuse across accounts. A bad saved token falls back to the provider without
marking the channel permanently refused. Its startup attempt is limited to eight
seconds within the existing overall deadline.

On a computer that can reach the provider, with Node 24 and GitHub CLI signed into
an account that can write the **private** backup repository:

```sh
node scripts/sync-streams.mjs --config /path/to/private/config.json --repository owner/private-backup --resolve-limit 20
```

The ignored config contains the same `server`, `username` and `password` as Render.
Alternatively set `XTREAM_SERVER`, `XTREAM_USERNAME` and `XTREAM_PASSWORD` for the
command. The command reads `direct_source` addresses already supplied in the
catalogue, then briefly resolves up to 20 missing/expiring addresses sequentially.
Discovery stops after three minutes and checkpoints progress; later runs skip
recent failures and valid unchanged addresses. `--resolve-limit 0` checks metadata
and supplied addresses without opening any live channel. Larger explicit limits
remain sequential and subject to the three-minute budget. Avoid discovery while
watching a subscription limited to one concurrent connection.

It writes private local snapshots and refuses to upload to a public repository. Use `--path` if the
M3U is in a subdirectory, keeping `resolved-streams.json` beside it. `--catalogue`
can use a previously downloaded private catalogue; `--categories` supplies its
category JSON. Reusing an old catalogue file does not give its URLs a fresh
observation time. These files contain access URLs and must stay out of `public/` and
the public application repository.

Render imports `resolved-streams.json` and `catalogue-snapshot.json` in the
background at startup and checks for updates at most every 15 minutes during
browsing/playback, using the existing `M3U_AUTH`. Conditional ETags avoid downloading
unchanged files. The full saved catalogue and categories are served without a
provider request, even when the Mac is offline; playback can still need the Mac
for channels without a usable public address.
The private remote file survives deployments; addresses learned only in Render's
temporary directory may not. An idle/sleeping Render instance is not a scheduler
for the local computer. Run the local sync again when a refresh is needed.

### Incremental updates and failure recovery

The provider API used here returns the complete channel/category lists. We compare
those responses by stable channel ID locally; this is not a provider delta API.
Only new/changed metadata and new/changed/near-expiry addresses alter snapshots.
Already learned public redirects survive unchanged catalogue rows. Identical runs
do not rewrite local snapshots or create GitHub commits. GitHub Contents updates
still send a complete changed file, protected by its SHA, not a wire-format patch.
The revision read at sync start must still match before upload, so competing Macs
and PCs cannot silently overwrite a newer backup.

Empty, malformed, duplicated-ID or failed catalogue responses abort synchronization.
Rows absent from a later response are retained rather than deleted automatically;
this deliberately prefers an old channel entry to losing channels after a partial
provider response. Use the sync summary's `retained` count to identify these cases.
Local writes are atomic and same-account concurrent runs are blocked by a PID lock.
Recent failed address discovery is retried after an hour; provider-only streams
after a day. A changed source fingerprint makes an earlier failure eligible again.

On the Mac, use the same Node/GitHub CLI command above with its private config.
It runs once and exits. This repository change does not install a scheduler on a
different computer or remove the working provider fallback.

### Fast browser startup and catalogue pages

After one successful visit, a service worker caches the public HTML and its
versioned JS/CSS assets. A repeat navigation displays that shell immediately and
refreshes it in the background. New HTML is cached only after its referenced
assets have been fetched, so a failed deployment download keeps the old shell.
No account/config APIs, stream URLs, manifests or live video enter this shell cache.
Browsers without service-worker/Cache Storage support retain normal online behavior.

The last complete channel list is stored in browser localStorage, scoped to the
access key. A remembered managed session can show it without waiting for the
server's configuration request. Failed refreshes and storage quota errors preserve
the previous list. Only complete paginated results replace the persistent cache.

Cold clients fetch `/api/xt?action=get_live_streams&limit=200&offset=0`; the first
200 channels render while further pages load in the background. Response headers
carry `X-Catalogue-Total` and `X-Catalogue-Revision`; subsequent pages send `revision`
to avoid mixing two versions. A revision mismatch returns 409 and the client
restarts once. A cached client sends `if_revision`; unchanged data returns an empty
body array with `X-Catalogue-Unchanged: true` and reuses the full browser cache.
Requests without pagination remain compatible with older clients.

This speeds up browsing, not an unbounded live feed: first-ever visits, deleted
browser storage, free-tier server wakeup and the upstream video source can still
add delay. Live video requires network access and cannot be cached ahead forever.

References: [GitHub conditional requests](https://docs.github.com/en/rest/using-the-rest-api/best-practices-for-using-the-rest-api#use-conditional-requests-if-appropriate),
[Contents media types and limits](https://docs.github.com/en/rest/repos/contents#get-repository-content),
[Service worker lifecycle and fallback](https://developer.mozilla.org/en-US/docs/Web/API/Service_Worker_API/Using_Service_Workers).

Saved URLs are candidates, not downloaded live video or guaranteed working
channels. Known `expires`, `exp` and `expiry` timestamps are honored; other
addresses have a seven-day application retention limit and are tested when
opened. The provider may reject or expire them sooner. Channels without a usable
saved address still need provider access. Logs contain only import counts/status,
and successful stream responses identify `X-Stream-Source: saved` or `provider`.

### Provider DNS while using the Mac exit node

`render-start.sh` enables `UPSTREAM_PROXY_LOCAL_DNS=1` for its local Tailscale
proxy. The application resolves provider names to public IPv4 addresses on
Render, sends a numeric HTTP CONNECT through Tailscale, and preserves the
original HTTP Host and HTTPS server name. Provider traffic still exits through
the Mac; it no longer needs the Mac's PeerAPI DNS resolver. DNS replies pointing
at private/local addresses are rejected. Set the flag to `0` to restore proxy-side
DNS for troubleshooting. Other proxy configurations keep their previous behavior
unless this option is explicitly enabled.

The startup `peer_dns` probe still tests the Mac's resolver, so it can report 500
while the application's provider health check succeeds using local DNS. Use
`/api/health` and actual playback to assess the application after this change.

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
