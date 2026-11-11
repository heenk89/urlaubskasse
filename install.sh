#!/usr/bin/env bash
# Urlaubskasse – Installation im (frischen) Debian-LXC.
# Aufruf im Container als root aus dem geklonten Repo:
#   bash /opt/urlaubskasse-src/install.sh
set -euo pipefail

SRC="$(cd "$(dirname "$(readlink -f "$0")")" && pwd)"
PORT="${URLAUB_PORT:-80}"
DATA="/var/lib/urlaubskasse"
USER_NAME="urlaubskasse"

if [ "$(id -u)" -ne 0 ]; then echo "Bitte als root ausführen."; exit 1; fi

# Schutz: nicht versehentlich auf dem Proxmox-Host installieren
if [ -d /etc/pve ] || command -v pct >/dev/null 2>&1; then
  echo "ABBRUCH: Das sieht nach dem Proxmox-Host aus. Bitte im Container ausführen (pct enter <ID>)."
  exit 1
fi

echo "== Pakete installieren"
apt-get update -qq
DEBIAN_FRONTEND=noninteractive apt-get install -y -qq python3 python3-flask python3-waitress git ca-certificates tzdata >/dev/null

echo "== Zeitzone Europe/Berlin"
ln -sf /usr/share/zoneinfo/Europe/Berlin /etc/localtime
echo "Europe/Berlin" > /etc/timezone

echo "== Benutzer und Datenordner"
id "$USER_NAME" >/dev/null 2>&1 || useradd --system --home "$DATA" --shell /usr/sbin/nologin "$USER_NAME"
mkdir -p "$DATA"
chown -R "$USER_NAME:$USER_NAME" "$DATA"
chmod 750 "$DATA"
chmod +x "$SRC"/*.sh "$SRC/urlaubskasse-admin"

echo "== systemd-Dienst (Port $PORT)"
cat > /etc/systemd/system/urlaubskasse.service <<EOF
[Unit]
Description=Urlaubskasse
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=$USER_NAME
Group=$USER_NAME
WorkingDirectory=$SRC
Environment=URLAUB_PORT=$PORT
Environment=URLAUB_DATA=$DATA
Environment=TZ=Europe/Berlin
# Hinter Reverse-Proxy mit HTTPS (Nginx Proxy Manager) aktivieren:
#Environment=URLAUB_SECURE_COOKIE=1
AmbientCapabilities=CAP_NET_BIND_SERVICE
ExecStart=/usr/bin/python3 $SRC/app.py
Restart=on-failure
RestartSec=3
NoNewPrivileges=true
ProtectSystem=strict
ProtectHome=true
ReadWritePaths=$DATA
PrivateTmp=true

[Install]
WantedBy=multi-user.target
EOF

echo "== Befehle urlaubskasse-update / urlaubskasse-admin"
for b in /usr/local/bin /usr/bin; do
  ln -sf "$SRC/update.sh" "$b/urlaubskasse-update"
  ln -sf "$SRC/urlaubskasse-admin" "$b/urlaubskasse-admin"
done

date '+%d.%m.%Y %H:%M' > "$SRC/.deployed"

systemctl daemon-reload
systemctl enable --now urlaubskasse.service >/dev/null
sleep 2
systemctl restart urlaubskasse.service

IP="$(hostname -I | awk '{print $1}')"
URL="http://$IP"; [ "$PORT" != "80" ] && URL="$URL:$PORT"
echo
echo "Fertig! Urlaubskasse läuft unter: $URL"
echo "Beim ersten Aufruf legst du im Browser dein Admin-Konto an."
echo "Status:  systemctl status urlaubskasse"
echo "Update:  urlaubskasse-update"
echo "Admin-Passwort vergessen:  urlaubskasse-admin <benutzername>"
