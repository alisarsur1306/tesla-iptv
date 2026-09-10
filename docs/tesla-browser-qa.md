# Tesla browser usability checks — 2026-09-10

Base: `4b47aec`, verified as Render's live revision when work started.
Changes are intended for the Tesla browser's touchscreen interface.

## Changes

- Replace the long horizontal category strip with a scrollable group picker. Keep All and Favorites directly available.
- Add a large Clear search button, an accessible search label, and blur the search field on submission.
- Reset the channel grid to its top when search or category changes. Preserve its position when returning from the player.
- Keep favorites usable in memory if writing browser storage fails.
- Keep the channel request deadline active until its response body is consumed. Previously a response that supplied headers and then stalled could leave loading pending indefinitely.

## Verification

- `npm run build`: passed.
- `npm test`: existing proxy gate/routing checks passed.
- `node --test src/lib/xtream.test.mjs`: five passed. Both stalled-body cases failed before the fix and passed afterward. Tests cover successful and error response bodies, normal completion, access-key rejection, and upstream error detail.
- Full suite (`node --test src/lib/*.test.mjs proxy/*.test.mjs`): 51 passed, 2 failed in unchanged proxy tests. `diag.test.mjs` expects an environment object without the existing `M3U_AUTH` field. `xtreamList.test.mjs` expects immediate fresh data after failure but receives a cached list. Neither test imports the changed frontend module.
- `npm run lint`: 17 errors and 1 warning both before and after the changes, with no added diagnostics.

## Browser checks

Chrome with a synthetic local catalogue (400 channels, 80 groups), at 1200×760 and 800×600:

- No horizontal document overflow; rendered buttons are at least 44px high.
- Open the picker, select group 77, and confirm that its five channels are shown.
- Hebrew and Arabic group labels render correctly.
- Search for Hebrew text; 80 matching fixture channels are shown.
- Load more channels, then search: the grid returns from a scroll offset above 3,600px to zero.
- Clear a search from the header and from the empty-state action.
- Add a favorite and select Favorites: the chosen channel is shown.
- Submit search: the input loses focus so the on-screen keyboard can dismiss.

This is desktop browser verification, not a test on Tesla hardware. Live playback and actual in-car keyboard behavior remain unverified. The local preview uses synthetic metadata and does not connect to the IPTV provider. Production was not deployed as part of these checks.

## Cloud-IP routing follow-up

The user's reported history concerns cloud-IP refusals after refreshing. Code inspection found
that routing used only fixed domain suffixes, ignoring the configured account host if it changed.
With no proxy configured it also selected direct transport on Render. Both paths were reproduced
using local HTTP fixtures; this does not establish the cause of the historical production incident.

- Add the configured account hostname to the routed hosts, including redirect hops.
- Block routed provider requests on Render when neither proxy transport is configured.
- Preserve local direct mode and direct requests to unrelated CDN hosts.
- Report the blocked transport accurately in diagnostics and correct misleading documentation
  that previously claimed every tunnel failure silently fell back to direct transport.
- `node --test proxy/routing.test.mjs`: six passed (four failed before the fix).
  Includes a failed-proxy response with no direct retry.
- Routing plus existing Worker tests: 11 passed. Build, `npm test`, and the five
  frontend deadline tests also passed after the routing change. Full suite: 57/59
  passed, with the same two failures recorded above.

A corporate VPN on the exit-node device can still change that device's outgoing IP. The changes
do not identify an IP as residential or verify the historical incident's egress address.
