#!/usr/bin/env bash
# Downloads the static tailscale/tailscaled binaries into the project root.
#
# Always downloads, deliberately. Skipping this when TS_AUTHKEY is unset at BUILD
# time is a trap: adding the key later only restarts the service, it does not
# rebuild, so the start script finds no ./tailscaled and the deploy dies while
# Render keeps serving the old instance. 30MB per build is worth avoiding that.
set -euo pipefail

VER="${TS_VERSION:-1.98.9}"
TARBALL="tailscale_${VER}_amd64.tgz"

curl -fsSL "https://pkgs.tailscale.com/stable/${TARBALL}" -o "/tmp/${TARBALL}"
tar -xzf "/tmp/${TARBALL}" -C /tmp
mv "/tmp/tailscale_${VER}_amd64/tailscale" "/tmp/tailscale_${VER}_amd64/tailscaled" .
chmod +x tailscale tailscaled
./tailscaled --version
