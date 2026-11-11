#!/usr/bin/env bash
# Wird von urlaubskasse-updater.service (systemd, als root) gestartet, sobald die
# App /var/lib/urlaubskasse/update.request anlegt (Update-Button in der Oberfläche).
# Schreibt das Protokoll nach update.log, das die App dem Admin anzeigt.
set -u
SRC="$(cd "$(dirname "$(readlink -f "$0")")" && pwd)"
DATA="${URLAUB_DATA:-/var/lib/urlaubskasse}"

rm -f "$DATA/update.request"
touch "$DATA/update.running"
cleanup() { chmod 644 "$DATA/update.log" 2>/dev/null; rm -f "$DATA/update.running"; }
trap cleanup EXIT

{
  echo "Update gestartet: $(date '+%d.%m.%Y %H:%M:%S')"
  bash "$SRC/update.sh" --force
  echo "Beendet: $(date '+%H:%M:%S') (Status $?)"
} > "$DATA/update.log" 2>&1
