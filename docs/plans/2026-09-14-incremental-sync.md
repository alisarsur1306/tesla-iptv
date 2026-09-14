# Incremental IPTV synchronization implementation plan

> **For Claude:** Use executing-plans to implement and verify these steps.

**Goal:** Preserve the complete catalogue and good stream addresses, updating only changed or expiring records, so browsing does not need the Mac and direct playback increasingly avoids provider discovery.

**Architecture:** Publish two account-scoped private snapshots beside the existing M3U. Catalogue records merge by provider ID; missing records survive incomplete responses. Address discovery reuses valid unchanged records, renews near expiry, and optionally resolves a bounded sequential batch of missing addresses with retry checkpoints. GitHub uploads compare existing content and use SHA concurrency control; Render uses conditional GET and keeps its previous snapshot on errors. Existing provider playback fallback remains for channels requiring it.

**Tech stack:** Node, undici, node:test, GitHub Contents API, existing Render proxy.

## Tasks

1. Add failing tests in `proxy/incrementalSync.test.mjs` for no-op runs, changed/new records, partial/empty failure protection, expiry renewal, account isolation and bounded discovery/retry. Implement `proxy/incrementalSync.mjs` and a bounded public redirect resolver.
2. Extend `proxy/syncStreams.test.mjs` to prove unchanged content produces no PUT and optimistic revision conflicts preserve the remote file. Implement private snapshot reading and conditional uploads in `proxy/syncStreams.mjs`; integrate the one-shot CLI with private atomic state and detailed counts.
3. Add `proxy/catalogueBackup.test.mjs` for full catalogue/category browsing without any provider calls, conditional refresh, cold restart and failure retention. Integrate private catalogue restore in `proxy/hlsProxy.mjs`; keep normal behavior when no snapshot exists.
4. Document the exact Mac command, delta semantics, bounded discovery, lack of all-channel guarantees, and the distinction between metadata delta and full upstream catalogue reads. Run `npm run check`, a real private sync twice (second unchanged upload skipped), then PR/merge/deploy and browser verification.
5. User follow-ups request browser caching and paging: cache only the public shell with offline fallback; initialize a previously managed browser from its scoped channel cache. Preserve old storage on quota/empty refresh failures. Serve 200-row catalogue pages with a stable revision, display the first page early, and persist only a completed list. Tests cover shell/API separation, failed shell updates, incremental page delivery, unchanged revisions and incomplete pagination.

## Constraints and evidence

- Existing live catalogue has 5,033 rows; 269 expose direct-source candidates. All records can be backed up, but not every subscription stream is guaranteed independent of the home IP.
- Provider API currently queried by this app returns a complete list. Changes are compared locally; do not claim an upstream delta API.
- Two additional local probes returned public MPEG-TS redirects; one connection attempt failed. Do not mass-open thousands of simultaneous streams or label a timeout as subscription denial.
- No recurring job is installed on the Mac from this Windows session unless remote access is available. The repeatable one-shot command works on either computer and leaves no server running.
- Live one-shot verification: full 5,033-row catalogue saved; 12 additional addresses resolved sequentially (281 total). Second fresh provider read reported 5,033 unchanged channels and zero changed addresses; both GitHub uploads were skipped.
- Browser verification with a 5,033-row fixture: first pages rendered before the complete list. After stopping the local production server, a reload restored the shell and complete list, and searching for row 5,033 succeeded. Failed refresh showed a retry notice while retaining the list.
- Cold-start regression: the first list request waits for bounded private restore when no disk catalogue exists, avoiding an unnecessary provider request during restore. The test failed before this fix and passed afterward.
