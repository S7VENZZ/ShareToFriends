#!/usr/bin/env bash
# ShareToFriends – Einrichtung des VPS-Servers.
# Verwendung:  ./setup.sh <domain>      z. B. ./setup.sh stf.s7venz.cloud
set -euo pipefail
cd "$(dirname "$0")"

DOMAIN="${1:-}"
if [ -z "$DOMAIN" ]; then
  echo "Verwendung: ./setup.sh <domain>   (der DNS-A-Eintrag muss auf diesen VPS zeigen)"
  exit 1
fi

if ! command -v docker >/dev/null 2>&1; then
  echo "Docker fehlt. Installation: curl -fsSL https://get.docker.com | sh"
  exit 1
fi
docker compose version >/dev/null 2>&1 || { echo "Docker-Compose-Plugin fehlt: sudo apt install docker-compose-plugin"; exit 1; }

umask 077
if [ ! -f .env ]; then
  printf 'TURN_SECRET=%s\n' "$(openssl rand -hex 32)" > .env
fi
sed -i '/^DOMAIN=/d' .env
printf 'DOMAIN=%s\n' "$DOMAIN" >> .env
# shellcheck disable=SC1091
source .env

sed "s|__TURN_SECRET__|${TURN_SECRET}|g; s|__DOMAIN__|${DOMAIN}|g" turnserver.conf.template > turnserver.conf
mkdir -p updates

docker compose pull coturn caddy
docker compose up -d --build

echo
echo "==================== ShareToFriends-Server läuft ===================="
echo " Signaling-URL für die App:  wss://${DOMAIN}/ws"
echo
echo " Cloud-Firewall des VPS freigeben (Eingehend):"
echo "   TCP 80, TCP 443          (Zertifikat + Signaling)"
echo "   UDP/TCP 3478             (STUN/TURN)"
echo "   UDP 49152-49252          (TURN-Relay)"
echo " Update-Feed der Apps:       https://${DOMAIN}/updates  (wird automatisch befüllt)"
echo " Zu Hause (Router/Heimnetz): nichts."
echo "====================================================================="
