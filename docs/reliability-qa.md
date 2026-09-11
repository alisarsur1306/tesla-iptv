# Reliability and comfort verification

## Automated gate

`npm run check` runs ESLint, all discovered Node tests, TypeScript and the Vite production build. Tests execute from a temporary source snapshot without local credentials or deployment proxy settings. GitHub Actions runs the same gate on pull requests and main; Render's Blueprint waits for CI and repeats the gate during build.

103 tests passed locally on Node 24, including stalled startup headers/body, URL key with disabled storage, malformed preferences, selected diagnostic route, rejected login, retry cancellation, old worker messages and retry-budget reset after brief rebuffering. The prior two baseline test failures were corrected for existing diagnostic fields and asynchronous cache recovery. Public CDN test calls were replaced with fixtures.

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

## Limits

This is browser and synthetic-media verification, not a Tesla hardware test. Provider login health does not prove that an individual channel plays, and the diagnostic egress address does not prove residential forwarding. Real car playback and the home exit node still need end-to-end verification.
