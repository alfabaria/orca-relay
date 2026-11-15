#!/bin/sh
# Create .env with fresh secrets. Usage: scripts/init-env.sh <auth-domain> <relay-domain>
# Example:     scripts/init-env.sh auth.example.com relay.example.com
# Secrets go only into .env (mode 600). They are never printed.
set -eu
[ $# -eq 2 ] || { echo "usage: $0 <auth-domain> <relay-domain>" >&2; exit 2; }
cd "$(dirname "$0")/.."
[ ! -e .env ] || { echo ".env exists; delete it first to rotate secrets" >&2; exit 1; }
command -v openssl >/dev/null || { echo "openssl is required" >&2; exit 1; }

password=$(openssl rand -base64 24 | tr -d '\n=' | tr '+/' '-_')
# PEM on one line with literal \n; auth/server.mjs converts them back.
key=$(openssl ecparam -name prime256v1 -genkey -noout | openssl pkcs8 -topk8 -nocrypt \
  | awk 'NF { printf "%s\\n", $0 }')
assign=$(openssl rand -hex 32)

umask 077
{
  printf 'AUTH_DOMAIN=%s\n' "$1"
  printf 'RELAY_DOMAIN=%s\n' "$2"
  printf "AUTH_PASSWORD='%s'\n" "$password"
  printf "AUTH_SIGNING_KEY='%s'\n" "$key"
  printf "RELAY_ASSIGNMENT_SIGNING_KEY='%s'\n" "$assign"
} > .env
echo "Wrote .env (mode 600). Sign-in password is AUTH_PASSWORD in that file."
