#!/usr/bin/env bash
# Render start command. Brings up Tailscale in userspace mode so requests to the
# Xtream API host can exit via a residential exit node (Cloudflare blocks Render's
# datacenter IPs), then starts the app. Unlisted CDN hosts go direct; configured
# provider hosts take the selected proxy route (see proxy/hlsProxy.mjs).
#
# Without TS_AUTHKEY, the app uses any separately configured Worker or HTTP
# proxy. With neither, known provider hosts are blocked on Render; local mode
# may connect directly. Startup configuration is not an egress health check.
set -euo pipefail

if [ -n "${TS_AUTHKEY:-}" ]; then
  PROXY_PORT="${TS_PROXY_PORT:-1055}"
  # Default socket path is /var/run/tailscale/, which is not writable on Render
  # (non-root) — tailscaled dies instantly with "bind: no such file or directory".
  TS_SOCKET=/tmp/tailscaled.sock

  # No --socks5-server: only the HTTP proxy is used, and Render's port scanner
  # probes any extra open port every 10s ("incompatible SOCKS version" log spam).
  ./tailscaled --tun=userspace-networking \
    --socket="${TS_SOCKET}" \
    --outbound-http-proxy-listen="127.0.0.1:${PROXY_PORT}" \
    --state=mem: &

  # Wait for the daemon's control socket instead of racing `up` against startup.
  for i in $(seq 1 30); do
    [ -S "${TS_SOCKET}" ] && break
    sleep 0.5
  done
  [ -S "${TS_SOCKET}" ] || { echo "tailscaled never created its socket" >&2; exit 1; }

  # --exit-node-allow-lan-access is not set: we want ALL proxied traffic to egress
  # at the exit node, never leak back out of Render.
  ./tailscale --socket="${TS_SOCKET}" up \
    --authkey="${TS_AUTHKEY}" \
    --exit-node="${TS_EXIT_NODE:?TS_EXIT_NODE must be set when TS_AUTHKEY is}" \
    --hostname="${TS_HOSTNAME:-tesla-iptv-render}" \
    --accept-routes=false

  ./tailscale --socket="${TS_SOCKET}" status --json > /dev/null \
    || { echo "tailscale failed to come up" >&2; exit 1; }
  export UPSTREAM_PROXY="127.0.0.1:${PROXY_PORT}"
  echo "Tailscale configured with an exit node; forwarding and provider access still need a health check"
else
  echo "TS_AUTHKEY unset; no Tailscale proxy started"
fi

if [ -n "${XTREAM_PROXY_URL:-}" ]; then
  echo "Provider transport: Worker (takes priority over UPSTREAM_PROXY)"
elif [ -n "${UPSTREAM_PROXY:-}" ]; then
  echo "Provider transport: HTTP proxy; use /api/health to check provider access"
elif [ "${RENDER:-}" = "true" ]; then
  echo "Provider transport: blocked (no Worker or HTTP proxy configured on Render)"
else
  echo "Provider transport: direct (local/non-Render mode)"
fi

exec node server.js
