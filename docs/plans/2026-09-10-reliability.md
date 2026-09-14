# Tesla reliability and comfort implementation plan

**Goal:** Complete the six improvements approved by the user: playback recovery, connection diagnosis, remembered viewing, unobstructed multilingual controls, bounded startup, and checks before publication.

**Architecture:** Keep the existing same-origin proxy and canvas player. Add cancellable deadlines and one bounded retry controller, safe local preferences, a locale provider, and a small key-gated health probe. Health describes provider reachability without claiming an IP is residential. Automatic recovery never overrides an explicit pause or starts a second stream.

**Tech stack:** React 19, TypeScript, WebCodecs worker, Node 24, node:test, GitHub Actions, Render.

## Work and validation

1. Player: regression tests for stalled reads, cancellation and retry limits; implement deadlines and recovery, manual retry, persisted volume and controls hidden only during healthy playback. Translate player strings.
2. Browser: validate persisted preferences, restore catalogue position, offer recent and last channels, translate browsing and category controls. Test stale IDs and unavailable storage.
3. Server: add bounded/coalesced health login probe, cover access gating, refusal, timeouts and selected transport with tests; correct diagnostic egress reporting and documentation. Preserve existing routing policy.
4. App: regression tests for stalled config headers/body and cancellation; add timed startup and retry UI, shared locale and safe recent-history persistence. Translate login/key screens and add user-facing connection status.
5. Delivery: run all node tests, TypeScript/build and lint from one command; GitHub Actions repeats the same command for PRs and main. Fix verified stale baseline test expectations and lint issues without hiding failures.
6. Review: use synthetic channel and failure fixtures to check desktop/Tesla-size layouts, language/RTL, history after reload and error recovery. Merge approved changes only after checks pass; verify Render serves the merged revision. Actual in-car playback and residential egress remain separate live checks.
