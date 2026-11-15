#!/bin/sh
# Manage sign-in users inside the running auth container. Run from the repo root.
#   scripts/user.sh add alice@example.com --name "Alice" [--generate]
#   scripts/user.sh list | passwd | disable | enable | revoke | remove <email>
# Run `scripts/user.sh` with no arguments for the full usage.
set -eu
cd "$(dirname "$0")/.."
# -it gives the hidden password prompt a terminal; piped stdin works without one.
if [ -t 0 ]; then tty=-it; else tty=-i; fi
exec docker compose exec $tty auth node admin.mjs user "$@"
