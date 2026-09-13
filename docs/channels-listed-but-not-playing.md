# Channels listed, nothing plays — 2026-09-13

Base: `57ec9c4` (the merge of the Tesla touchscreen work). Reported symptom: the channel list
loads, tapping a channel plays nothing, and `/api/diag?quick=1` looks healthy.

## Why the diagnosis was empty

`/api/diag` only ever checked the *list* path — `player_api login`, `get_live_streams`, and the
M3U backup. Playing a channel is a different request (a different URL shape, a different id
space, an MPEG-TS body), so a deployment whose channels all refused to play still reported a
clean bill of health. There was nothing to read, which is why "tailscale is working" and
"nothing plays" could both be true at once.

The player said as little: `/api/stream` forwarded a provider 403 verbatim into the decoder,
which reported `HTTP 403`, retried it five times, gave up with "stream lost", and the overlay
retried that three more times before showing "Playback failed: stream lost".

## Changes

- `/api/diag` gained a `live stream <id>` check (`&stream=<id>` to choose one). It reports the
  status, the id space used, the transport, which host actually served the bytes, and whether
  those bytes are MPEG-TS, a playlist, or a block page.
- `/api/stream` resolves a channel in **both** id spaces (the Xtream `stream_id` and the id in
  the backup playlist's URLs) and falls through to the second when the first is refused. The
  client's list can come from either — its localStorage copy outlives a server restart, and the
  server switches source whenever the provider stalls — and `liveListSource` was only ever a
  guess about which one it was holding.
- A failed stream now answers with a sentence naming the channel, each host tried, its
  transport, and what it answered, plus `retryable: false` when the answer cannot change. The
  worker surfaces that text and stops reconnecting; the overlay shows it instead of retrying.
- A cached Xtream list served during the provider's cooldown now records that it *is* an Xtream
  list. It did not, so `/api/stream` went on resolving those ids in the backup's id space —
  everything listed, nothing playable, with no outage to point at.
- `noteUnavailable()` was written in `4b47aec` and never called, so the grid's "Not included in
  your subscription" marking could never appear. It is now called when a stream is refused and
  no source served it. A 403 carrying an HTML body (a Cloudflare interstitial) is never
  recorded: the record is permanent, and a broken transport would otherwise erase the catalogue
  one tap at a time.
- The provider recovering mid-request now wins over the backup instead of staying shadowed for
  the rest of the cooldown.

## Verification

- `node --test src/lib/*.test.mjs proxy/*.test.mjs`: 66 passed, 0 failed (was 57/59).
  The two pre-existing failures were not product bugs: `diag.test.mjs` asserted an env report
  that predated `M3U_AUTH`, and `xtreamList.test.mjs` was reading another test file's fixtures
  out of the shared on-disk list cache. Test files now each get their own `CACHE_DIR`
  (`proxy/testCacheDir.mjs`); with that isolation one assertion turned out to have been passing
  on leftover state, and it now asserts the documented recovery instead.
- New `proxy/stream.test.mjs`: cross-source fallback, the reported failure text, the refusal
  record, a Cloudflare 403 *not* being recorded, and the diag playback probe.
- `npm run build`: passed. `npm run lint`: 17 errors and 1 warning, unchanged from before
  (all pre-existing, in `src/components/ui/*` and the vestigial `_creds` params).
- Local end-to-end against a synthetic provider (300 channels, one of them answering 403),
  driven in headless Chromium at 1200×760 and 800×600: the grid renders, the group picker
  opens, a good channel streams, and the refused one shows the provider's reason and is dimmed
  as "Not included in your subscription" on the next load.

This is a synthetic provider on localhost. It does not reproduce the user's production
failure, and does not establish which cause is behind it — it establishes that the cause will
now be visible in `/api/diag` and in the player, and that two of the ways a listed channel
could fail to play are gone.


## Follow-up: the fix above made it load forever (same day)

Reported immediately after deploying the change above: the spinner never ends.

That was this change's own regression. `resolveStreamTargets()` resolved BOTH id spaces up
front, and resolving the backup's means downloading the playlist — up to `LIST_TIMEOUT_MS`
(90s) on a container that has not fetched it yet. So every `/api/stream` request waited on the
backup before the provider was even asked, which on a cold Render instance is a minute of
"Loading…" per channel tap. It only bites a deployment with `M3U_URL` set, which is why the
local run that checked the refusal path (no backup configured) never saw it.

- The provider's URL is a plain string — building it costs nothing — while the backup's is now
  a thunk, resolved only when the backup is the source the client is actually holding, or when
  the provider has already refused.
- Every resolution is bounded. Falling back gets `FAST_FAIL_MS`, because a fallback that
  arrives after the viewer has given up is worth nothing. The first target gets the full list
  budget only when the backup is the sole source; with a provider URL available it gets
  `FAST_FAIL_MS` too, and then the provider is tried.
- `isGenuineRefusal()` read the 403's body with no deadline, long after the connect timer was
  cleared. A body that never finished arriving would have held the request open with nothing
  left to stop it. It is bounded now, and an unreadable refusal is not recorded.

Measured against a synthetic provider with a deliberately 20-second backup playlist: a channel
the provider serves answers in 0.03s and never touches the playlist (it took ~20s before the
fix); a refused channel falls through to the backup and reports within the 8s bound instead of
hanging. `proxy/stream.test.mjs` now fails on the previous commit and passes on this one.
Suite: 67 passed, 0 failed. Build clean; lint unchanged at 17 pre-existing errors.
