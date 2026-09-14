#!/usr/bin/env bash
# Best-effort startup evidence only. Never change routing or fall back to direct.
# Five seconds TSMP + ten seconds numeric HTTP + optional ten seconds hostname.
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
  local label="$1" target="$2" status curl_exit
  # -q must be first: ignore curlrc. Empty noproxy overrides NO_PROXY='*'.
  # HTTP forward mode matches undici's default transport for HTTP targets.
  status=$({ timeout --signal=KILL 10s curl -q --silent \
    --proxy "$proxy" --noproxy '' --proto '=http' \
    --connect-timeout 5 --max-time 10 --retry 0 --no-location --max-redirs 0 \
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
exit 0
