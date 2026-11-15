#!/bin/sh
# Install the nginx vhosts for the relay on a host that already runs nginx + certbot.
# Run from the repo root after scripts/init-env.sh. Needs sudo. Existing vhosts are not touched.
set -eu
cd "$(dirname "$0")/.."
[ -f .env ] || { echo "run scripts/init-env.sh first" >&2; exit 1; }
set -a; . ./.env; set +a
AUTH_PORT=${AUTH_PORT:-18081}; RELAY_PORT=${RELAY_PORT:-18082}
export AUTH_DOMAIN RELAY_DOMAIN AUTH_PORT RELAY_PORT
dest=/etc/nginx/sites-available/orca-relay.conf
[ ! -e "$dest" ] || { echo "$dest exists; remove it to reinstall" >&2; exit 1; }
# Only these four variables are substituted; nginx's own $host etc. stay intact.
envsubst '${AUTH_DOMAIN} ${RELAY_DOMAIN} ${AUTH_PORT} ${RELAY_PORT}' < deploy/nginx.conf.template \
  | sudo tee "$dest" >/dev/null
sudo ln -s "$dest" /etc/nginx/sites-enabled/orca-relay.conf
if sudo nginx -t; then
  sudo systemctl reload nginx
else
  sudo rm -f /etc/nginx/sites-enabled/orca-relay.conf "$dest"
  echo "nginx -t failed; vhost removed, nginx not reloaded" >&2; exit 1
fi
echo "Installed. Next: sudo certbot --nginx -d $AUTH_DOMAIN -d $RELAY_DOMAIN"
