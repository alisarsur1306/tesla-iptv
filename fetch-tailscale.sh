#!/usr/bin/env bash
# Downloads the static tailscale/tailscaled binaries into the project root.
# Skipped entirely when TS_AUTHKEY is unset, so builds without an exit node stay fast.
set -euo pipefail

if [ -z "${TS_AUTHKEY:-}" ]; then
  echo "TS_AUTHKEY unset — skipping Tailscale download"
  exit 0
fi

VER="${TS_VERSION:-1.98.9}"
TARBALL="tailscale_${VER}_amd64.tgz"

curl -fsSL "https://pkgs.tailscale.com/stable/${TARBALL}" -o "/tmp/${TARBALL}"
tar -xzf "/tmp/${TARBALL}" -C /tmp
mv "/tmp/tailscale_${VER}_amd64/tailscale" "/tmp/tailscale_${VER}_amd64/tailscaled" .
chmod +x tailscale tailscaled
./tailscaled --version
