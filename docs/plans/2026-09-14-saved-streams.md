# Saved stream addresses implementation plan

**Goal:** Open channels from privately saved direct video addresses without requiring the home Mac for every playback attempt, and support a one-time refresh from this Windows computer.

**Architecture:** An account-scoped server cache stores only public HTTP(S) video addresses. Successful redirected playback learns additional addresses; a local sync reads the provider's `direct_source` catalogue fields without opening every stream. A private GitHub sidecar beside the existing private M3U backup provides persistence across Render deployments. Cache misses or rejected addresses use the existing provider path under the same startup deadline. Saved addresses are never returned in ordinary channel responses.

**Tech Stack:** Node 24, existing HTTP proxy and test runner, authenticated private GitHub Contents API.

## Evidence and limits

- Local account login succeeded and returned 5,033 channels, including 269 nonempty direct-source addresses.
- Al Jazeera HD redirected to an unrelated HTTPS video host; requesting that address through Render returned HTTP 200 and a valid HLS manifest without the Mac.
- This establishes reusable discovery for that request, not decoded playback or validity of every address. Cache expiry and actual playback still require verification.
- Render's Mac DNS handler still returns HTTP 500. Saved URLs reduce dependence but do not repair that local resolver.

## Tasks

1. Write failing cache tests for account isolation, private URL rejection, expiry, disk reload and size limits. Implement atomic private persistence and a bounded private sidecar refresh.
2. Write failing stream integration tests: saved URL works with a broken provider, bad saved URL is evicted and falls back, successful direct redirects are learned, and failed cached addresses never mark an account's channel permanently unavailable. Implement cache-first candidates within the existing deadline.
3. Implement a local sync command with IPv4 transport, no raw URL/credential logging, bounded catalogue retrieval, and private-repository validation before sidecar upload. Test pure catalogue extraction and document refresh instructions.
4. Run lint/tests/build; merge and deploy under existing authorization. Upload the one-time snapshot to the existing private backup repository, verify it survives reload, then test actual browser playback on at least two available channels. Report precisely which channels were populated and any unresolved provider/Mac limitation.

## Scoped DNS repair

The user also authorized repairing the connection. Tailscale numeric forwarding
works while its Mac DNS handler fails. Enable local public IPv4 resolution only
for the startup-managed Tailscale proxy, then use numeric CONNECT while keeping
the original Host/TLS server name. Wire-level tests must establish that the
provider still travels through the proxy and that private DNS results are refused.
The live provider health check and HTTPS egress probe remain the deployment gate.
