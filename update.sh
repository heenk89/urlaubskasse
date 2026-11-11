#!/usr/bin/env bash
# Holt die neueste Version aus Gitea und startet den Dienst neu.
#   urlaubskasse-update            nur wenn es etwas Neues gibt
#   urlaubskasse-update --force    immer neu starten
set -euo pipefail

SRC="$(cd "$(dirname "$(readlink -f "$0")")" && pwd)"
cd "$SRC"
version() { python3 -c 'import json;print(json.load(open("VERSION.json"))["version"])'; }

git fetch --quiet
if [ "$(git rev-parse HEAD)" = "$(git rev-parse '@{u}')" ] && [ "${1:-}" != "--force" ]; then
  echo "Bereits aktuell ($(git rev-parse --short HEAD), $(version))."
  exit 0
fi

ALT="$(git rev-parse --short HEAD)"
git pull --ff-only --quiet
chmod +x "$SRC"/*.sh "$SRC/urlaubskasse-admin"
date '+%d.%m.%Y %H:%M' > "$SRC/.deployed"
systemctl restart urlaubskasse.service
sleep 1

echo "Aktualisiert: $ALT -> $(git rev-parse --short HEAD) ($(version))"
systemctl is-active --quiet urlaubskasse.service && echo "Dienst läuft." || { echo "FEHLER: Dienst läuft nicht!"; journalctl -u urlaubskasse -n 30 --no-pager; exit 1; }
