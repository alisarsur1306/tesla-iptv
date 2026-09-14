#!/usr/bin/env bash
# Best-effort startup evidence only. Never change routing or fall back to direct.
# At most 36 seconds in the background, including selected-exit DNS evidence.
set -uo pipefail

socket="${1:-}"
exit_node="${2:-}"
proxy="${3:-}"

if [[ -z "$socket" || -z "$exit_node" || ! "$proxy" =~ ^(http://)?127\.0\.0\.1:[0-9]+$ ]]; then
  echo '[tunnel-check] skipped=invalid_probe_configuration'
  exit 0
fi
if ! command -v timeout >/dev/null 2>&1 || ! command -v curl >/dev/null 2>&1; then
  echo '[tunnel-check] skipped=probe_tool_unavailable'
  exit 0
fi
[[ "$proxy" = http://* ]] || proxy="http://$proxy"

# The CLI's ping timeout excludes daemon initialization, so cap the whole process.
if { timeout --signal=KILL 5s ./tailscale --socket="$socket" ping --tsmp --c=1 --timeout=5s "$exit_node"; } >/dev/null 2>&1; then
  echo '[tunnel-check] tsmp=reachable'
else
  echo "[tunnel-check] tsmp=unavailable exit=$?"
fi

http_probe() {
  local label="$1" target="$2" budget="${3:-10}" status curl_exit
  # -q must be first: ignore curlrc. Empty noproxy overrides NO_PROXY='*'.
  # HTTP forward mode matches undici's default transport for HTTP targets.
  status=$({ timeout --signal=KILL "${budget}s" curl -q --silent \
    --proxy "$proxy" --noproxy '' --proto '=http' \
    --connect-timeout 5 --max-time "$budget" --retry 0 --no-location --max-redirs 0 \
    --output /dev/null --write-out '%{http_code}' --url "$target"; } 2>/dev/null)
  curl_exit=$?
  if [[ "$status" =~ ^[1-9][0-9][0-9]$ ]]; then
    echo "[tunnel-check] $label=response http=$status exit=$curl_exit"
    return 0
  fi
  echo "[tunnel-check] $label=no_response exit=$curl_exit"
  return 1
}

# Numeric IPv4 avoids destination DNS. Any HTTP status is recorded as a response,
# including gateway errors; it is not proof of residential egress or playback.
if http_probe numeric_http 'http://1.1.1.1/'; then
  http_probe hostname_http 'http://api.ipify.org?format=json' || true
else
  echo '[tunnel-check] hostname_http=skipped reason=no_numeric_response'
fi

# Outbound hostname resolution uses the exit node's PeerAPI DNS service. Parse
# status privately; accept only the selected exit and its own numeric Tailscale
# address. The original URL is never evaluated by the shell or written to logs.
if command -v node >/dev/null 2>&1 && peer_dns_url=$({
  timeout --signal=KILL 3s ./tailscale --socket="$socket" status --json |
    timeout --signal=KILL 3s node -e '
      const { isIP } = require("node:net");
      const normalize = (ip) => {
        if (typeof ip !== "string") return null;
        if (isIP(ip) === 4) {
          const octets = ip.split(".").map(Number);
          return octets[0] === 100 && octets[1] >= 64 && octets[1] <= 127 ? ip : null;
        }
        if (isIP(ip) === 6 && ip.toLowerCase().startsWith("fd7a:115c:a1e0:")) {
          return new URL("http://[" + ip + "]/").hostname.slice(1, -1);
        }
        return null;
      };
      let raw = "";
      process.stdin.setEncoding("utf8");
      process.stdin.on("data", (chunk) => {
        raw += chunk;
        if (raw.length > 1048576) process.exit(1);
      });
      process.stdin.on("end", () => {
        try {
          const configured = process.argv[1];
          const expected = normalize(configured);
          const status = JSON.parse(raw);
          const peers = Object.values(status.Peer || {}).filter((peer) => peer?.ExitNode === true);
          if (peers.length !== 1) throw new Error();
          const peer = peers[0];
          if (!Array.isArray(peer.TailscaleIPs) || !Array.isArray(peer.PeerAPIURL)) throw new Error();
          const ips = peer.TailscaleIPs.map(normalize).filter(Boolean);
          if (expected) {
            if (!ips.includes(expected)) throw new Error();
          } else {
            const canonicalName = (name) => typeof name === "string" ? name.toLowerCase().replace(/\.$/, "") : "";
            const names = [peer.DNSName, peer.HostName].map(canonicalName).filter(Boolean);
            if (isIP(configured) || !names.includes(canonicalName(configured))) throw new Error();
          }
          for (const candidate of peer.PeerAPIURL) {
            if (typeof candidate !== "string" || !/^http:\/\/(?:\[[0-9a-fA-F:]+\]|[0-9.]+):[0-9]+\/?$/.test(candidate)) continue;
            const url = new URL(candidate);
            const ip = normalize(url.hostname.replace(/^\[|\]$/g, ""));
            const port = Number(url.port || 80);
            if (!ip || !ips.includes(ip) || port < 1 || port > 65535) continue;
            url.pathname = "/dns-query";
            url.search = "?q=api.ipify.org&t=a";
            process.stdout.write(url.href);
            return;
          }
          process.exit(1);
        } catch {
          process.exit(1);
        }
      });
    ' "$exit_node"
} 2>/dev/null); then
  # HTTP 200 records a response only; the discarded DNS body is not validated.
  http_probe peer_dns "$peer_dns_url" 8 || true
else
  echo '[tunnel-check] peer_dns=skipped reason=invalid_exit_status'
fi
exit 0
