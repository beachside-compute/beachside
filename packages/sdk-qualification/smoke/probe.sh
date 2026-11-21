#!/bin/sh
# Beachside provider smoke probe. POSIX sh only: it must run on every provider's base image,
# with or without bash, curl, python3 or node. It prints one key=value line per finding and
# writes a marker file the runner reads back. It never sees provider credentials, only the
# random SMOKE_* values the runner set, so nothing it prints can leak a key.
# Usage: sh probe.sh <marker-file>
set -u

marker=${1:-/tmp/beachside-smoke.out}

out() { printf '%s=%s\n' "$1" "$2"; }

has() { command -v "$1" >/dev/null 2>&1; }

# Environment: create-time, per-command, override order, child and login shells.
out env_create "${SMOKE_CREATE:-}"
out env_odd "${SMOKE_ODD:-}"
out env_call "${SMOKE_CALL:-}"
out env_both "${SMOKE_BOTH:-}"
out env_child "$(sh -c 'printf %s "${SMOKE_CREATE:-}"')"
out env_login_sh "$(sh -lc 'printf %s "${SMOKE_CREATE:-}"' 2>/dev/null)"

if has bash; then
  out env_login_bash "$(bash -lc 'printf %s "${SMOKE_CREATE:-}"' 2>/dev/null)"
else
  out env_login_bash "-"
fi

# Who and where the command runs.
out uid "$(id -u 2>/dev/null)"
out user "$(id -un 2>/dev/null)"
out home "${HOME:-}"
out cwd "$(pwd)"
out path_set "$([ -n "${PATH:-}" ] && echo yes || echo no)"
out tmp_writable "$(t=$(mktemp 2>/dev/null) && rm -f "$t" && echo yes || echo no)"

tools=""

for tool in bash curl wget python3 node npm git tar sha256sum; do
  has "$tool" && tools="$tools $tool"
done

out tools "${tools# }"

# Clock: the runner compares this with its own time.
out epoch "$(date -u +%s)"

# File round trip: the runner copies this file back with `beachside cp`.
if printf '%s|%s\n' "${SMOKE_CREATE:-}" "$(date -u +%s)" > "$marker" 2>/dev/null; then
  out marker_written yes
else
  out marker_written no
fi

# Network: DNS, then HTTPS with whichever client the image has.
url=https://beachside.run/

if has getent; then
  out dns "$(getent hosts beachside.run >/dev/null 2>&1 && echo yes || echo no)"
else
  out dns "-"
fi

status=""
client=none

if has curl; then
  client=curl
  status=$(curl -sS -o /dev/null -w '%{http_code}' --max-time 20 "$url" 2>/dev/null)
elif has wget; then
  client=wget
  status=$(wget -q -S -T 20 -O /dev/null "$url" 2>&1 | awk '/HTTP\//{code=$2} END{print code}')
elif has python3; then
  client=python3
  status=$(python3 -c 'import sys, urllib.request
try:
    print(urllib.request.urlopen(sys.argv[1], timeout=20).status)
except Exception as error:
    print(getattr(error, "code", "error"))' "$url" 2>/dev/null)
elif has node; then
  client=node
  status=$(node -e 'fetch(process.argv[1], { signal: AbortSignal.timeout(20000) }).then((r) => console.log(r.status), () => console.log("error"))' "$url" 2>/dev/null)
fi

out net_client "$client"
out net_status "${status:-error}"
out done yes
