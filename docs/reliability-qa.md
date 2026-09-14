# Reliability and comfort verification

## Automated gate

`npm run check` runs ESLint, all discovered Node tests, TypeScript and the Vite production build. Tests execute from a temporary source snapshot without local credentials or deployment proxy settings. GitHub Actions runs the same gate on pull requests and main; Render's Blueprint waits for CI and repeats the gate during build.

134 tests passed locally on Node 24, including stalled startup headers/body, URL key with disabled storage, malformed preferences, selected diagnostic route, rejected login, retry cancellation, old worker messages, retry-budget reset after brief rebuffering, stream deadline cleanup and finite-response draining. ESLint, TypeScript and the production build also passed. The prior two baseline test failures were corrected for existing diagnostic fields and asynchronous cache recovery. Public CDN test calls were replaced with fixtures.

## Browser verification

Chrome with a local synthetic catalogue (500 channels, 12 groups) and FFmpeg-generated H.264/AAC MPEG-TS test pattern. No account credentials or real provider streams used.

- Hebrew and Arabic translations and RTL controls displayed; English remains available.
- Hebrew layout at 800×600 had no horizontal overflow; category picker selection/close worked.
- Language, Group 3 and the search `Channel` survived refresh.
- Expanded list survived refresh: 240 channel cards; scroll offset 3935.20 before and after.
- Synthetic video frames displayed; idle controls disappeared and touch revealed them.
- Pause changed to the paused state; volume 90% survived channel change.
- A synthetic unavailable channel exhausted bounded retries and showed localized Retry/Back.
- Manual retry could be cancelled by returning to browsing.
- Recent channel IDs and the Continue shortcut survived refresh.

### Playback regression checks, September 14

- A finite H.264/AAC TS response delivered in one burst displayed the generated test pattern in Chrome. The worker drains queued transport data, decoder output and presentation frames before reconnecting at EOF.
- A synthetic settled provider refusal displayed the safe explanation and manual Retry/Back controls immediately, without automatic retries or displaying raw server error text.
- Client request headers and first picture have a 75-second budget, allowing the server's 60-second startup/fallback budget to complete. Subsequent byte-read inactivity is limited to 20 seconds; picture inactivity after the first frame is limited to 30 seconds.

### Live incident evidence, September 14

The live revision was `c2aa88d`, before this PR. Al Jazeera HD remained on Loading, and Render logged a stream response with status 504. The authenticated diagnostic selected the Tailscale tunnel; both the provider request and independent egress check timed out. The authenticated GitHub backup playlist remained reachable with HTTP 200. Tailscale administration showed both Render and the configured Mac exit node connected, with exit routing allowed and an allow-all access policy. This isolates a forwarding problem on the configured tunnel path, independently of video decoding or playlist availability. It does not establish which device or network hop failed.

Local playback improvements do not restore a disconnected exit node. Live playback must be checked again after the tunnel is working.

## Limits

This is browser and synthetic-media verification, not a Tesla hardware test. Provider login health does not prove that an individual channel plays, and the diagnostic egress address does not prove residential forwarding. Real car playback and the home exit node still need end-to-end verification.
