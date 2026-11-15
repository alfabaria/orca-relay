#!/bin/sh
# macOS: launch Orca against your own auth + relay instead of Orca Cloud.
# Usage: scripts/orca-with-relay.sh https://auth.example.com https://relay.example.com
# Orca is single-instance and reads these variables only at launch, so quit it first.
# Launching Orca any other way goes back to Orca Cloud and needs a fresh sign-in.
set -eu
[ $# -eq 2 ] || { echo "usage: $0 <auth-url> <relay-url>" >&2; exit 2; }
case "$1$2" in
  https://*https://*) ;;
  *) echo "both URLs must start with https://" >&2; exit 2 ;;
esac
if pgrep -f "Orca.app/Contents/MacOS/Orca" >/dev/null; then
  echo "Quit Orca first (Cmd+Q), then rerun." >&2
  exit 1
fi
open -a Orca \
  --env ORCA_CLOUD_API_URL="$1" \
  --env ORCA_CLOUD_CLIENT_ID=orca-desktop \
  --env ORCA_RELAY_URL="$2"
echo "Orca launched against $2. Sign in to Orca Cloud in the app; the browser shows your password page."
