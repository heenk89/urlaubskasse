"""Urlaubskasse – gemeinsame Ausgaben im Urlaub fair aufteilen.

Flask + SQLite. Mehrere Projekte/Ausflüge, Teilnehmer mit oder ohne eigenes
Login, Rechte pro Teilnehmer, Auswertung „wer zahlt wem wie viel“.
by Daniel Henk
"""
import csv
import io
import json
import os
import secrets
import sqlite3
import sys
import tempfile
import time
from datetime import date, datetime, timedelta
from decimal import ROUND_HALF_UP, Decimal, InvalidOperation
from fractions import Fraction
from functools import wraps
from pathlib import Path

from flask import (Flask, Response, abort, g, jsonify, request, send_file,
                   send_from_directory, session)
from werkzeug.exceptions import HTTPException
from werkzeug.security import check_password_hash, generate_password_hash

BASE = Path(__file__).resolve().parent
DATA_DIR = Path(os.environ.get("URLAUB_DATA", "/var/lib/urlaubskasse"))
DB_PATH = DATA_DIR / "urlaubskasse.db"

KATEGORIEN = {
    "unterkunft": "🏠 Unterkunft",
    "essen": "🍽️ Essen",
    "getraenke": "🍺 Getränke",
    "einkauf": "🛒 Einkauf",
    "tickets": "🎟️ Tickets / Eintritt",
    "transport": "🚗 Fahrt / Sprit",
    "aktivitaet": "🏄 Aktivitäten",
    "sonstiges": "📦 Sonstiges",
}
STUFEN = {
    "r_eintragen": ("nein", "selbst", "alle"),
    "r_bearbeiten": ("nein", "eigene", "alle"),
    "r_loeschen": ("nein", "eigene", "alle"),
}
MAX_BETRAG = 1_000_000_00  # 1 Mio. in Cent

app = Flask(__name__, static_folder=None)
app.json.sort_keys = False
app.config["SESSION_COOKIE_HTTPONLY"] = True
app.config["SESSION_COOKIE_SAMESITE"] = "Lax"
app.config["SESSION_COOKIE_SECURE"] = os.environ.get("URLAUB_SECURE_COOKIE") == "1"
app.config["SESSION_COOKIE_NAME"] = "urlaubskasse"
app.config["PERMANENT_SESSION_LIFETIME"] = timedelta(days=90)
app.config["MAX_CONTENT_LENGTH"] = 1024 * 1024

SCHEMA = """
CREATE TABLE IF NOT EXISTS einstellungen (
    schluessel TEXT PRIMARY KEY,
    wert TEXT
);
CREATE TABLE IF NOT EXISTS benutzer (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    login TEXT NOT NULL UNIQUE COLLATE NOCASE,
    name TEXT NOT NULL,
    pw_hash TEXT NOT NULL,
    admin INTEGER NOT NULL DEFAULT 0,
    darf_projekte INTEGER NOT NULL DEFAULT 1,
    aktiv INTEGER NOT NULL DEFAULT 1,
    pw_version INTEGER NOT NULL DEFAULT 1,
    erstellt TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS projekte (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    beschreibung TEXT NOT NULL DEFAULT '',
    von TEXT,
    bis TEXT,
    waehrung TEXT NOT NULL DEFAULT '€',
    ersteller_id INTEGER NOT NULL REFERENCES benutzer(id),
    abgeschlossen INTEGER NOT NULL DEFAULT 0,
    erstellt TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS teilnehmer (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    projekt_id INTEGER NOT NULL REFERENCES projekte(id) ON DELETE CASCADE,
    name TEXT NOT NULL,
    benutzer_id INTEGER REFERENCES benutzer(id) ON DELETE SET NULL,
    gewicht INTEGER NOT NULL DEFAULT 1,
    aktiv INTEGER NOT NULL DEFAULT 1,
    r_eintragen TEXT NOT NULL DEFAULT 'selbst',
    r_bearbeiten TEXT NOT NULL DEFAULT 'eigene',
    r_loeschen TEXT NOT NULL DEFAULT 'eigene',
    r_verwalten INTEGER NOT NULL DEFAULT 0,
    UNIQUE (projekt_id, benutzer_id)
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_tn_name ON teilnehmer(projekt_id, name COLLATE NOCASE);
CREATE TABLE IF NOT EXISTS ausgaben (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    projekt_id INTEGER NOT NULL REFERENCES projekte(id) ON DELETE CASCADE,
    art TEXT NOT NULL DEFAULT 'ausgabe' CHECK (art IN ('ausgabe','zahlung')),
    beschreibung TEXT NOT NULL DEFAULT '',
    kategorie TEXT NOT NULL DEFAULT 'sonstiges',
    betrag INTEGER NOT NULL CHECK (betrag > 0),
    datum TEXT NOT NULL,
    zahler_id INTEGER NOT NULL REFERENCES teilnehmer(id),
    empfaenger_id INTEGER REFERENCES teilnehmer(id),
    notiz TEXT NOT NULL DEFAULT '',
    erstellt_von INTEGER REFERENCES benutzer(id) ON DELETE SET NULL,
    erstellt TEXT NOT NULL,
    geaendert TEXT
);
CREATE INDEX IF NOT EXISTS idx_ausgaben_projekt ON ausgaben(projekt_id);
CREATE TABLE IF NOT EXISTS anteile (
    ausgabe_id INTEGER NOT NULL REFERENCES ausgaben(id) ON DELETE CASCADE,
    teilnehmer_id INTEGER NOT NULL REFERENCES teilnehmer(id),
    gewicht INTEGER NOT NULL DEFAULT 1,
    PRIMARY KEY (ausgabe_id, teilnehmer_id)
);
CREATE TABLE IF NOT EXISTS verlauf (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    projekt_id INTEGER NOT NULL REFERENCES projekte(id) ON DELETE CASCADE,
    benutzer TEXT NOT NULL DEFAULT '',
    zeit TEXT NOT NULL,
    text TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_verlauf_projekt ON verlauf(projekt_id);
"""


# ================================================================ Datenbank
def db():
    if "db" not in g:
        g.db = sqlite3.connect(DB_PATH, timeout=10)
        g.db.row_factory = sqlite3.Row
        g.db.execute("PRAGMA foreign_keys = ON")
    return g.db


@app.teardown_appcontext
def close_db(_exc):
    con = g.pop("db", None)
    if con is not None:
        con.close()


def init_db():
    DATA_DIR.mkdir(parents=True, exist_ok=True)
    con = sqlite3.connect(DB_PATH)
    con.executescript(SCHEMA)
    con.execute("PRAGMA journal_mode = WAL")
    if not con.execute("SELECT 1 FROM einstellungen WHERE schluessel='secret_key'").fetchone():
        con.execute("INSERT INTO einstellungen VALUES ('secret_key', ?)", (secrets.token_hex(32),))
    con.commit()
    app.secret_key = con.execute(
        "SELECT wert FROM einstellungen WHERE schluessel='secret_key'").fetchone()[0]
    con.close()


# ================================================================ Hilfen
def jetzt():
    return datetime.now().strftime("%Y-%m-%d %H:%M:%S")


def heute():
    return date.today().isoformat()


class Fehler(Exception):
    def __init__(self, msg, code=400):
        super().__init__(msg)
        self.msg, self.code = msg, code


@app.errorhandler(Fehler)
def _fehler(e):
    return jsonify({"fehler": e.msg}), e.code


@app.errorhandler(HTTPException)
def _http(e):
    if request.path.startswith("/api/"):
        texte = {404: "Nicht gefunden", 403: "Keine Berechtigung", 401: "Nicht angemeldet",
                 413: "Anfrage zu groß", 415: "Ungültige Anfrage", 405: "Nicht erlaubt"}
        return jsonify({"fehler": texte.get(e.code, e.name)}), e.code
    return e


def text(data, key, maxlen=200, pflicht=False, name=None):
    val = str(data.get(key) or "").strip()[:maxlen]
    if pflicht and not val:
        raise Fehler(f"{name or key} fehlt")
    return val


def parse_datum(val, pflicht=False):
    if val in (None, ""):
        if pflicht:
            raise Fehler("Datum fehlt")
        return None
    try:
        return date.fromisoformat(str(val)).isoformat()
    except ValueError:
        raise Fehler(f"Ungültiges Datum: {val}")


def parse_betrag(val):
    """'12,50' / '12.50' / '1.234,56' / 12.5 -> Cent (int)."""
    s = str(val if val is not None else "").strip().replace("€", "").replace(" ", "")
    if not s:
        raise Fehler("Betrag fehlt")
    if "," in s and "." in s:
        s = s.replace(".", "").replace(",", ".")
    else:
        s = s.replace(",", ".")
    try:
        cent = int((Decimal(s) * 100).quantize(Decimal("1"), rounding=ROUND_HALF_UP))
    except (InvalidOperation, ValueError):
        raise Fehler(f"Ungültiger Betrag: {val}")
    if cent <= 0:
        raise Fehler("Betrag muss größer als 0 sein")
    if cent > MAX_BETRAG:
        raise Fehler("Betrag zu groß")
    return cent


def euro(cent, waehrung="€"):
    s = f"{cent / 100:,.2f}".replace(",", "X").replace(".", ",").replace("X", ".")
    return f"{s} {waehrung}"


def as_int(val, name="ID"):
    try:
        return int(val)
    except (TypeError, ValueError):
        raise Fehler(f"Ungültige {name}")


def version_info():
    try:
        info = json.loads((BASE / "VERSION.json").read_text(encoding="utf-8"))
    except Exception:
        info = {"version": "?", "datum": ""}
    stamp = BASE / ".deployed"
    info["update"] = stamp.read_text(encoding="utf-8").strip() if stamp.exists() else ""
    info.pop("aenderungen", None)
    return info


# ================================================================ Anmeldung
def aktueller_benutzer():
    if "user" not in g:
        g.user = None
        uid = session.get("uid")
        if uid:
            row = db().execute("SELECT * FROM benutzer WHERE id=? AND aktiv=1", (uid,)).fetchone()
            if row and row["pw_version"] == session.get("pwv"):
                g.user = row
    return g.user


def login_noetig(f):
    @wraps(f)
    def wrapper(*a, **kw):
        if not aktueller_benutzer():
            raise Fehler("Nicht angemeldet", 401)
        return f(*a, **kw)
    return wrapper


def admin_noetig(f):
    @wraps(f)
    def wrapper(*a, **kw):
        u = aktueller_benutzer()
        if not u:
            raise Fehler("Nicht angemeldet", 401)
        if not u["admin"]:
            raise Fehler("Nur für Admins", 403)
        return f(*a, **kw)
    return wrapper


@app.before_request
def csrf_schutz():
    # Ändernde API-Aufrufe nur als JSON: ein fremdes Formular kann kein JSON
    # mit Cookie senden (SameSite=Lax + kein CORS) -> Schutz gegen CSRF.
    if request.method in ("POST", "PUT", "PATCH", "DELETE") and request.path.startswith("/api/"):
        if not request.is_json:
            abort(415)


def benutzer_dict(u, voll=False):
    d = {"id": u["id"], "login": u["login"], "name": u["name"], "admin": bool(u["admin"]),
         "darf_projekte": bool(u["darf_projekte"] or u["admin"])}
    if voll:
        d.update(aktiv=bool(u["aktiv"]), erstellt=u["erstellt"])
    return d


def pruefe_passwort(pw):
    if len(pw or "") < 6:
        raise Fehler("Passwort muss mindestens 6 Zeichen haben")
    if len(pw) > 200:
        raise Fehler("Passwort zu lang")


def pruefe_login(login):
    login = (login or "").strip()
    if not login or len(login) > 40 or any(c.isspace() for c in login):
        raise Fehler("Benutzername: 1–40 Zeichen, ohne Leerzeichen")
    return login


_fehlversuche = {}


@app.get("/api/status")
def status():
    u = aktueller_benutzer()
    setup = db().execute("SELECT COUNT(*) FROM benutzer").fetchone()[0] == 0
    return jsonify({**version_info(), "setup_noetig": setup,
                    "benutzer": benutzer_dict(u) if u else None,
                    "kategorien": KATEGORIEN, "heute": heute()})


@app.post("/api/setup")
def setup():
    """Erster Start: ersten Admin anlegen."""
    data = request.get_json(silent=True) or {}
    con = db()
    if con.execute("SELECT COUNT(*) FROM benutzer").fetchone()[0] > 0:
        raise Fehler("Einrichtung ist schon erledigt", 409)
    login = pruefe_login(data.get("login"))
    name = text(data, "name", 60) or login
    pruefe_passwort(data.get("passwort"))
    cur = con.execute(
        "INSERT INTO benutzer (login,name,pw_hash,admin,darf_projekte,erstellt) VALUES (?,?,?,1,1,?)",
        (login, name, generate_password_hash(data["passwort"]), jetzt()))
    con.commit()
    session.clear()
    session.permanent = True
    session["uid"], session["pwv"] = cur.lastrowid, 1
    return jsonify({"ok": True})


@app.post("/api/login")
def login():
    data = request.get_json(silent=True) or {}
    ip = request.headers.get("X-Forwarded-For", request.remote_addr or "").split(",")[0].strip()
    versuche = [t for t in _fehlversuche.get(ip, []) if t > time.time() - 900]
    if len(versuche) >= 10:
        raise Fehler("Zu viele Fehlversuche – bitte 15 Minuten warten", 429)
    row = db().execute("SELECT * FROM benutzer WHERE login=? COLLATE NOCASE AND aktiv=1",
                       ((data.get("login") or "").strip(),)).fetchone()
    if not row or not check_password_hash(row["pw_hash"], data.get("passwort") or ""):
        versuche.append(time.time())
        _fehlversuche[ip] = versuche
        time.sleep(1.2)
        raise Fehler("Benutzername oder Passwort falsch", 401)
    _fehlversuche.pop(ip, None)
    session.clear()
    session.permanent = True
    session["uid"], session["pwv"] = row["id"], row["pw_version"]
    return jsonify({"ok": True, "benutzer": benutzer_dict(row)})


@app.post("/api/logout")
def logout():
    session.clear()
    return jsonify({"ok": True})


@app.post("/api/konto/passwort")
@login_noetig
def passwort_aendern():
    u = aktueller_benutzer()
    data = request.get_json(silent=True) or {}
    if not check_password_hash(u["pw_hash"], data.get("alt") or ""):
        time.sleep(1)
        raise Fehler("Bisheriges Passwort stimmt nicht", 403)
    pruefe_passwort(data.get("neu"))
    con = db()
    con.execute("UPDATE benutzer SET pw_hash=?, pw_version=pw_version+1 WHERE id=?",
                (generate_password_hash(data["neu"]), u["id"]))
    con.commit()
    session["pwv"] = u["pw_version"] + 1
    return jsonify({"ok": True})


@app.put("/api/konto")
@login_noetig
def konto_aendern():
    u = aktueller_benutzer()
    data = request.get_json(silent=True) or {}
    name = text(data, "name", 60, pflicht=True, name="Name")
    db().execute("UPDATE benutzer SET name=? WHERE id=?", (name, u["id"]))
    db().commit()
    return jsonify({"ok": True})


# ================================================================ Benutzerverwaltung (Admin)
@app.get("/api/benutzer")
@admin_noetig
def benutzer_liste():
    rows = db().execute("""
        SELECT b.*, (SELECT COUNT(*) FROM projekte p WHERE p.ersteller_id=b.id) AS projekte,
               (SELECT COUNT(*) FROM teilnehmer t WHERE t.benutzer_id=b.id) AS mitglied
        FROM benutzer b ORDER BY b.name COLLATE NOCASE""").fetchall()
    out = []
    for r in rows:
        d = benutzer_dict(r, voll=True)
        d.update(projekte=r["projekte"], mitglied=r["mitglied"])
        out.append(d)
    return jsonify(out)


@app.get("/api/benutzer/namen")
@login_noetig
def benutzer_namen():
    """Auswahlliste zum Verknüpfen von Teilnehmern mit Konten."""
    rows = db().execute("SELECT id, login, name FROM benutzer WHERE aktiv=1 "
                        "ORDER BY name COLLATE NOCASE").fetchall()
    return jsonify([dict(r) for r in rows])


@app.post("/api/benutzer")
@admin_noetig
def benutzer_neu():
    data = request.get_json(silent=True) or {}
    login = pruefe_login(data.get("login"))
    name = text(data, "name", 60) or login
    pruefe_passwort(data.get("passwort"))
    con = db()
    if con.execute("SELECT 1 FROM benutzer WHERE login=? COLLATE NOCASE", (login,)).fetchone():
        raise Fehler("Benutzername ist schon vergeben", 409)
    cur = con.execute(
        "INSERT INTO benutzer (login,name,pw_hash,admin,darf_projekte,erstellt) VALUES (?,?,?,?,?,?)",
        (login, name, generate_password_hash(data["passwort"]), int(bool(data.get("admin"))),
         int(bool(data.get("darf_projekte", True))), jetzt()))
    con.commit()
    return jsonify({"ok": True, "id": cur.lastrowid})


def admins_uebrig(con, ohne_id):
    return con.execute("SELECT COUNT(*) FROM benutzer WHERE admin=1 AND aktiv=1 AND id<>?",
                       (ohne_id,)).fetchone()[0]


@app.put("/api/benutzer/<int:bid>")
@admin_noetig
def benutzer_aendern(bid):
    me = aktueller_benutzer()
    con = db()
    u = con.execute("SELECT * FROM benutzer WHERE id=?", (bid,)).fetchone()
    if not u:
        abort(404)
    data = request.get_json(silent=True) or {}
    name = text(data, "name", 60) or u["name"]
    admin = int(bool(data.get("admin", u["admin"])))
    aktiv = int(bool(data.get("aktiv", u["aktiv"])))
    darf = int(bool(data.get("darf_projekte", u["darf_projekte"])))
    if bid == me["id"] and (not admin or not aktiv):
        raise Fehler("Du kannst dir selbst die Admin-Rechte nicht entziehen")
    if (not admin or not aktiv) and u["admin"] and admins_uebrig(con, bid) == 0:
        raise Fehler("Es muss mindestens ein aktiver Admin bleiben")
    con.execute("UPDATE benutzer SET name=?, admin=?, aktiv=?, darf_projekte=? WHERE id=?",
                (name, admin, aktiv, darf, bid))
    if data.get("passwort"):
        pruefe_passwort(data["passwort"])
        con.execute("UPDATE benutzer SET pw_hash=?, pw_version=pw_version+1 WHERE id=?",
                    (generate_password_hash(data["passwort"]), bid))
    con.commit()
    if bid == me["id"] and data.get("passwort"):
        session["pwv"] = me["pw_version"] + 1
    return jsonify({"ok": True})


@app.delete("/api/benutzer/<int:bid>")
@admin_noetig
def benutzer_loeschen(bid):
    me = aktueller_benutzer()
    if bid == me["id"]:
        raise Fehler("Du kannst dich nicht selbst löschen")
    con = db()
    u = con.execute("SELECT * FROM benutzer WHERE id=?", (bid,)).fetchone()
    if not u:
        abort(404)
    if con.execute("SELECT 1 FROM projekte WHERE ersteller_id=?", (bid,)).fetchone():
        raise Fehler("Benutzer hat Projekte angelegt – bitte stattdessen deaktivieren "
                     "oder die Projekte vorher löschen", 409)
    con.execute("DELETE FROM benutzer WHERE id=?", (bid,))
    con.commit()
    return jsonify({"ok": True})


@app.get("/api/backup")
@admin_noetig
def backup():
    tmp = Path(tempfile.mkdtemp()) / "backup.db"
    src = sqlite3.connect(DB_PATH)
    dst = sqlite3.connect(tmp)
    src.backup(dst)
    dst.close()
    src.close()
    name = f"urlaubskasse-{datetime.now():%Y-%m-%d_%H%M}.db"
    return send_file(tmp, as_attachment=True, download_name=name)


# ================================================================ Update aus der Oberfläche
UPDATE_REQ = DATA_DIR / "update.request"
UPDATE_RUN = DATA_DIR / "update.running"
UPDATE_LOG = DATA_DIR / "update.log"
UPDATE_UNIT = Path("/etc/systemd/system/urlaubskasse-update.path")


def update_status():
    log, stamp = "", ""
    if UPDATE_LOG.exists():
        try:
            log = UPDATE_LOG.read_text(encoding="utf-8", errors="replace")[-6000:]
            stamp = datetime.fromtimestamp(UPDATE_LOG.stat().st_mtime).strftime("%d.%m.%Y %H:%M")
        except OSError:
            pass
    return {"laeuft": UPDATE_REQ.exists() or UPDATE_RUN.exists(), "log": log, "log_zeit": stamp,
            "verfuegbar": UPDATE_UNIT.exists(), **version_info()}


@app.get("/api/update")
@admin_noetig
def update_info():
    return jsonify(update_status())


@app.post("/api/update")
@admin_noetig
def update_starten():
    if not UPDATE_UNIT.exists():
        raise Fehler("Update-Dienst ist noch nicht eingerichtet. Einmal in der Shell "
                     "„urlaubskasse-update --force“ ausführen, danach geht es per Button.", 409)
    if UPDATE_REQ.exists() or UPDATE_RUN.exists():
        raise Fehler("Ein Update läuft bereits", 409)
    try:
        UPDATE_LOG.unlink(missing_ok=True)
    except OSError:
        pass
    UPDATE_REQ.write_text(jetzt(), encoding="utf-8")
    return jsonify({"ok": True})


# ================================================================ Projekt-Kontext & Rechte
class Ctx:
    """Wer darf was in einem Projekt."""

    def __init__(self, projekt, user, tn):
        self.p, self.u, self.tn = projekt, user, tn
        self.ist_ersteller = projekt["ersteller_id"] == user["id"]
        self.ist_admin = bool(user["admin"])
        self.voll = bool(self.ist_admin or self.ist_ersteller or (tn and tn["r_verwalten"]))
        self.gesperrt = bool(projekt["abgeschlossen"]) and not self.voll

    @property
    def tn_id(self):
        return self.tn["id"] if self.tn else None

    def stufe(self, key):
        if self.voll:
            return "alle"
        if self.gesperrt or not self.tn:
            return "nein"
        return self.tn[key]

    def darf_fuer(self, zahler_id, empfaenger_id=None):
        """Darf für diesen Zahler (bzw. diese Zahlung) eintragen?"""
        s = self.stufe("r_eintragen")
        if s == "alle":
            return True
        return s == "selbst" and self.tn_id is not None and self.tn_id in (zahler_id, empfaenger_id)

    def eigene(self, a):
        return (a["erstellt_von"] == self.u["id"]) or (
            self.tn_id is not None and self.tn_id in (a["zahler_id"], a["empfaenger_id"]))

    def darf(self, key, a):
        s = self.stufe(key)
        return s == "alle" or (s == "eigene" and self.eigene(a))

    def rechte(self):
        return {"voll": self.voll, "ersteller": self.ist_ersteller or self.ist_admin,
                "gesperrt": self.gesperrt, "teilnehmer_id": self.tn_id,
                "r_eintragen": self.stufe("r_eintragen"),
                "r_bearbeiten": self.stufe("r_bearbeiten"),
                "r_loeschen": self.stufe("r_loeschen")}


def lade_ctx(pid):
    u = aktueller_benutzer()
    p = db().execute("SELECT * FROM projekte WHERE id=?", (pid,)).fetchone()
    if not p:
        abort(404)
    tn = db().execute("SELECT * FROM teilnehmer WHERE projekt_id=? AND benutzer_id=?",
                      (pid, u["id"])).fetchone()
    if not (u["admin"] or p["ersteller_id"] == u["id"] or tn):
        abort(404)
    return Ctx(p, u, tn)


def nur_voll(ctx):
    if not ctx.voll:
        raise Fehler("Nur Projektersteller, Verwalter oder Admin dürfen das", 403)


def log(pid, txt):
    u = aktueller_benutzer()
    db().execute("INSERT INTO verlauf (projekt_id, benutzer, zeit, text) VALUES (?,?,?,?)",
                 (pid, u["name"] if u else "", jetzt(), txt[:500]))


# ================================================================ Berechnung
def verteilen(betrag, gewichte):
    """Betrag (Cent) nach Gewichten aufteilen, Rest-Cents gerecht verteilen.
    gewichte: Liste (teilnehmer_id, gewicht). Summe der Teile == betrag."""
    total = sum(w for _, w in gewichte)
    if total <= 0:
        return {}
    teile, reste = {}, []
    for tid, w in gewichte:
        q, r = divmod(betrag * w, total)
        teile[tid] = q
        reste.append((-r, tid))
    for _, tid in sorted(reste)[: betrag - sum(teile.values())]:
        teile[tid] += 1
    return teile


def runden(exakt):
    """Fraction-Beträge auf ganze Cent runden, Summe bleibt erhalten."""
    teile = {tid: int(v) for tid, v in exakt.items()}  # Brüche >= 0 -> int() = abrunden
    rest = round(sum(exakt.values())) - sum(teile.values())
    reihenfolge = sorted(exakt, key=lambda tid: (-(exakt[tid] - teile[tid]), tid))
    for tid in reihenfolge[:rest]:
        teile[tid] += 1
    return teile


def ausgleich(salden):
    """Möglichst wenige Überweisungen: größter Schuldner an größten Gläubiger."""
    plus = sorted(([v, t] for t, v in salden.items() if v > 0), key=lambda x: (-x[0], x[1]))
    minus = sorted(([-v, t] for t, v in salden.items() if v < 0), key=lambda x: (-x[0], x[1]))
    out, i, j = [], 0, 0
    while i < len(minus) and j < len(plus):
        b = min(minus[i][0], plus[j][0])
        out.append({"von": minus[i][1], "an": plus[j][1], "betrag": b})
        minus[i][0] -= b
        plus[j][0] -= b
        if minus[i][0] == 0:
            i += 1
        if plus[j][0] == 0:
            j += 1
    return out


def projekt_daten(pid):
    """Teilnehmer, Ausgaben (inkl. Anteile) und Auswertung eines Projekts."""
    con = db()
    tns = con.execute("""
        SELECT t.*, b.name AS benutzer_name, b.login AS benutzer_login
        FROM teilnehmer t LEFT JOIN benutzer b ON b.id=t.benutzer_id
        WHERE t.projekt_id=? ORDER BY t.id""", (pid,)).fetchall()
    rows = con.execute("""
        SELECT a.*, b.name AS ersteller_name FROM ausgaben a
        LEFT JOIN benutzer b ON b.id=a.erstellt_von
        WHERE a.projekt_id=? ORDER BY a.datum DESC, a.id DESC""", (pid,)).fetchall()
    ant = {}
    for r in con.execute("""SELECT an.* FROM anteile an JOIN ausgaben a ON a.id=an.ausgabe_id
                            WHERE a.projekt_id=? ORDER BY an.teilnehmer_id""", (pid,)):
        ant.setdefault(r["ausgabe_id"], []).append((r["teilnehmer_id"], r["gewicht"]))

    s = {t["id"]: {"bezahlt": 0, "anteil": 0, "gezahlt": 0, "erhalten": 0} for t in tns}
    exakt = {t["id"]: Fraction(0) for t in tns}  # Anteile ungerundet, gerundet wird erst die Summe
    gesamt, kat, ausgaben = 0, {}, []
    for a in rows:
        d = dict(a)
        if a["art"] == "ausgabe":
            gew = ant.get(a["id"], [])
            teile = verteilen(a["betrag"], gew)
            summe_w = sum(w for _, w in gew)
            gesamt += a["betrag"]
            kat[a["kategorie"]] = kat.get(a["kategorie"], 0) + a["betrag"]
            s[a["zahler_id"]]["bezahlt"] += a["betrag"]
            for tid, w in gew:
                exakt[tid] += Fraction(a["betrag"] * w, summe_w)
            d["anteile"] = [{"teilnehmer_id": tid, "gewicht": w, "betrag": teile.get(tid, 0)}
                            for tid, w in ant.get(a["id"], [])]
        else:
            s[a["zahler_id"]]["gezahlt"] += a["betrag"]
            s[a["empfaenger_id"]]["erhalten"] += a["betrag"]
            d["anteile"] = []
        ausgaben.append(d)

    # Summe der Anteile auf Cent runden (größter Rest zuerst) -> Summe == gesamt
    for tid, c in runden(exakt).items():
        s[tid]["anteil"] = c
    teilnehmer, salden = [], {}
    for t in tns:
        x = s[t["id"]]
        saldo = x["bezahlt"] - x["anteil"] + x["gezahlt"] - x["erhalten"]
        salden[t["id"]] = saldo
        teilnehmer.append({
            "id": t["id"], "name": t["name"], "benutzer_id": t["benutzer_id"],
            "benutzer_name": t["benutzer_name"], "benutzer_login": t["benutzer_login"],
            "gewicht": t["gewicht"], "aktiv": bool(t["aktiv"]),
            "r_eintragen": t["r_eintragen"], "r_bearbeiten": t["r_bearbeiten"],
            "r_loeschen": t["r_loeschen"], "r_verwalten": bool(t["r_verwalten"]),
            **x, "saldo": saldo,
        })
    return {
        "teilnehmer": teilnehmer,
        "ausgaben": ausgaben,
        "auswertung": {
            "gesamt": gesamt,
            "kategorien": dict(sorted(kat.items(), key=lambda kv: -kv[1])),
            "ausgleich": ausgleich(salden),
            "offen": sum(v for v in salden.values() if v > 0),
        },
    }


def projekt_kopf(p):
    return {k: p[k] for k in ("id", "name", "beschreibung", "von", "bis", "waehrung",
                              "ersteller_id", "erstellt")} | {"abgeschlossen": bool(p["abgeschlossen"])}


# ================================================================ Projekte
@app.get("/api/projekte")
@login_noetig
def projekte_liste():
    u = aktueller_benutzer()
    con = db()
    if u["admin"]:
        rows = con.execute("SELECT * FROM projekte ORDER BY abgeschlossen, COALESCE(von, erstellt) DESC").fetchall()
    else:
        rows = con.execute("""
            SELECT DISTINCT p.* FROM projekte p LEFT JOIN teilnehmer t ON t.projekt_id=p.id
            WHERE p.ersteller_id=? OR t.benutzer_id=?
            ORDER BY p.abgeschlossen, COALESCE(p.von, p.erstellt) DESC""", (u["id"], u["id"])).fetchall()
    out = []
    for p in rows:
        d = projekt_daten(p["id"])
        mein = next((t for t in d["teilnehmer"] if t["benutzer_id"] == u["id"]), None)
        ersteller = con.execute("SELECT name FROM benutzer WHERE id=?", (p["ersteller_id"],)).fetchone()
        out.append(projekt_kopf(p) | {
            "gesamt": d["auswertung"]["gesamt"],
            "anzahl_teilnehmer": len(d["teilnehmer"]),
            "anzahl_ausgaben": sum(1 for a in d["ausgaben"] if a["art"] == "ausgabe"),
            "mein_saldo": mein["saldo"] if mein else None,
            "offen": d["auswertung"]["offen"],
            "ersteller_name": ersteller["name"] if ersteller else "",
        })
    return jsonify(out)


def projekt_felder(data, alt=None):
    alt = alt or {}
    name = text(data, "name", 80) if "name" in data else alt.get("name", "")
    if not name:
        raise Fehler("Name fehlt")
    von = parse_datum(data.get("von")) if "von" in data else alt.get("von")
    bis = parse_datum(data.get("bis")) if "bis" in data else alt.get("bis")
    if von and bis and bis < von:
        raise Fehler("„bis“ liegt vor „von“")
    return {
        "name": name,
        "beschreibung": text(data, "beschreibung", 500) if "beschreibung" in data else alt.get("beschreibung", ""),
        "von": von, "bis": bis,
        "waehrung": (text(data, "waehrung", 5) or "€") if "waehrung" in data else alt.get("waehrung", "€"),
    }


@app.post("/api/projekte")
@login_noetig
def projekt_neu():
    u = aktueller_benutzer()
    if not (u["admin"] or u["darf_projekte"]):
        raise Fehler("Du darfst keine Projekte anlegen", 403)
    data = request.get_json(silent=True) or {}
    f = projekt_felder(data)
    con = db()
    pid = con.execute("""INSERT INTO projekte (name,beschreibung,von,bis,waehrung,ersteller_id,erstellt)
                         VALUES (?,?,?,?,?,?,?)""",
                      (f["name"], f["beschreibung"], f["von"], f["bis"], f["waehrung"], u["id"], jetzt())).lastrowid
    namen = []
    if data.get("mitmachen", True):
        con.execute("""INSERT INTO teilnehmer (projekt_id,name,benutzer_id,r_eintragen,r_bearbeiten,
                       r_loeschen,r_verwalten) VALUES (?,?,?,'alle','alle','alle',1)""", (pid, u["name"], u["id"]))
        namen.append(u["name"].lower())
    for n in data.get("teilnehmer") or []:
        n = str(n).strip()[:60]
        if n and n.lower() not in namen:
            con.execute("INSERT INTO teilnehmer (projekt_id,name) VALUES (?,?)", (pid, n))
            namen.append(n.lower())
    log(pid, f"Projekt „{f['name']}“ angelegt")
    con.commit()
    return jsonify({"ok": True, "id": pid})


@app.get("/api/projekte/<int:pid>")
@login_noetig
def projekt_detail(pid):
    ctx = lade_ctx(pid)
    d = projekt_daten(pid)
    for a in d["ausgaben"]:
        a["darf_bearbeiten"] = ctx.darf("r_bearbeiten", a)
        a["darf_loeschen"] = ctx.darf("r_loeschen", a)
    return jsonify({"projekt": projekt_kopf(ctx.p), "rechte": ctx.rechte(), **d})


@app.put("/api/projekte/<int:pid>")
@login_noetig
def projekt_aendern(pid):
    ctx = lade_ctx(pid)
    nur_voll(ctx)
    data = request.get_json(silent=True) or {}
    f = projekt_felder(data, dict(ctx.p))
    abg = int(bool(data.get("abgeschlossen", ctx.p["abgeschlossen"])))
    con = db()
    con.execute("UPDATE projekte SET name=?,beschreibung=?,von=?,bis=?,waehrung=?,abgeschlossen=? WHERE id=?",
                (f["name"], f["beschreibung"], f["von"], f["bis"], f["waehrung"], abg, pid))
    if abg != ctx.p["abgeschlossen"]:
        log(pid, "Projekt abgeschlossen" if abg else "Projekt wieder geöffnet")
    else:
        log(pid, "Projekteinstellungen geändert")
    con.commit()
    return jsonify({"ok": True})


@app.delete("/api/projekte/<int:pid>")
@login_noetig
def projekt_loeschen(pid):
    ctx = lade_ctx(pid)
    if not (ctx.ist_ersteller or ctx.ist_admin):
        raise Fehler("Nur der Projektersteller oder ein Admin darf das Projekt löschen", 403)
    con = db()
    con.execute("DELETE FROM anteile WHERE ausgabe_id IN (SELECT id FROM ausgaben WHERE projekt_id=?)", (pid,))
    con.execute("DELETE FROM ausgaben WHERE projekt_id=?", (pid,))
    con.execute("DELETE FROM teilnehmer WHERE projekt_id=?", (pid,))
    con.execute("DELETE FROM verlauf WHERE projekt_id=?", (pid,))
    con.execute("DELETE FROM projekte WHERE id=?", (pid,))
    con.commit()
    return jsonify({"ok": True})


@app.get("/api/projekte/<int:pid>/verlauf")
@login_noetig
def projekt_verlauf(pid):
    lade_ctx(pid)
    rows = db().execute("SELECT benutzer, zeit, text FROM verlauf WHERE projekt_id=? "
                        "ORDER BY id DESC LIMIT 500", (pid,)).fetchall()
    return jsonify([dict(r) for r in rows])


# ================================================================ Teilnehmer
def tn_felder(ctx, data, alt=None):
    alt = dict(alt) if alt else {}
    con = db()
    bid = data.get("benutzer_id", alt.get("benutzer_id"))
    bid = as_int(bid, "Benutzer") if bid not in (None, "", 0, "0") else None
    if bid is not None:
        b = con.execute("SELECT * FROM benutzer WHERE id=?", (bid,)).fetchone()
        if not b:
            raise Fehler("Benutzer nicht gefunden")
        dop = con.execute("SELECT 1 FROM teilnehmer WHERE projekt_id=? AND benutzer_id=? AND id<>?",
                          (ctx.p["id"], bid, alt.get("id", 0))).fetchone()
        if dop:
            raise Fehler("Dieses Konto ist schon mit einem anderen Teilnehmer verknüpft", 409)
    name = text(data, "name", 60) if "name" in data else alt.get("name", "")
    if not name and bid is not None:
        name = b["name"]
    if not name:
        raise Fehler("Name fehlt")
    dop = con.execute("SELECT 1 FROM teilnehmer WHERE projekt_id=? AND name=? COLLATE NOCASE AND id<>?",
                      (ctx.p["id"], name, alt.get("id", 0))).fetchone()
    if dop:
        raise Fehler(f"„{name}“ gibt es in diesem Projekt schon", 409)
    gewicht = as_int(data.get("gewicht", alt.get("gewicht", 1)), "Gewichtung")
    if not 1 <= gewicht <= 20:
        raise Fehler("Gewichtung muss zwischen 1 und 20 liegen")
    f = {"name": name, "benutzer_id": bid, "gewicht": gewicht,
         "aktiv": int(bool(data.get("aktiv", alt.get("aktiv", 1))))}
    for key, erlaubt in STUFEN.items():
        val = data.get(key, alt.get(key, erlaubt[1]))
        if val not in erlaubt:
            raise Fehler(f"Ungültiger Wert für {key}")
        f[key] = val
    verw = int(bool(data.get("r_verwalten", alt.get("r_verwalten", 0))))
    if verw != int(alt.get("r_verwalten", 0)) and not (ctx.ist_ersteller or ctx.ist_admin):
        raise Fehler("Nur der Projektersteller darf Verwalter-Rechte vergeben", 403)
    f["r_verwalten"] = verw
    return f


@app.post("/api/projekte/<int:pid>/teilnehmer")
@login_noetig
def tn_neu(pid):
    ctx = lade_ctx(pid)
    nur_voll(ctx)
    f = tn_felder(ctx, request.get_json(silent=True) or {})
    con = db()
    tid = con.execute("""INSERT INTO teilnehmer (projekt_id,name,benutzer_id,gewicht,aktiv,r_eintragen,
                         r_bearbeiten,r_loeschen,r_verwalten) VALUES (?,?,?,?,?,?,?,?,?)""",
                      (pid, f["name"], f["benutzer_id"], f["gewicht"], f["aktiv"], f["r_eintragen"],
                       f["r_bearbeiten"], f["r_loeschen"], f["r_verwalten"])).lastrowid
    log(pid, f"Teilnehmer „{f['name']}“ hinzugefügt")
    con.commit()
    return jsonify({"ok": True, "id": tid})


def lade_tn(tid):
    t = db().execute("SELECT * FROM teilnehmer WHERE id=?", (tid,)).fetchone()
    if not t:
        abort(404)
    return t


@app.put("/api/teilnehmer/<int:tid>")
@login_noetig
def tn_aendern(tid):
    t = lade_tn(tid)
    ctx = lade_ctx(t["projekt_id"])
    nur_voll(ctx)
    f = tn_felder(ctx, request.get_json(silent=True) or {}, t)
    # Projektersteller darf sich nicht selbst aussperren
    if t["benutzer_id"] == ctx.p["ersteller_id"] and f["benutzer_id"] != t["benutzer_id"]:
        raise Fehler("Die Verknüpfung des Projekterstellers kann nicht geändert werden")
    con = db()
    con.execute("""UPDATE teilnehmer SET name=?,benutzer_id=?,gewicht=?,aktiv=?,r_eintragen=?,
                   r_bearbeiten=?,r_loeschen=?,r_verwalten=? WHERE id=?""",
                (f["name"], f["benutzer_id"], f["gewicht"], f["aktiv"], f["r_eintragen"],
                 f["r_bearbeiten"], f["r_loeschen"], f["r_verwalten"], tid))
    log(t["projekt_id"], f"Teilnehmer „{f['name']}“ geändert")
    con.commit()
    return jsonify({"ok": True})


@app.delete("/api/teilnehmer/<int:tid>")
@login_noetig
def tn_loeschen(tid):
    t = lade_tn(tid)
    ctx = lade_ctx(t["projekt_id"])
    nur_voll(ctx)
    con = db()
    benutzt = con.execute("""SELECT 1 FROM ausgaben WHERE zahler_id=? OR empfaenger_id=?
                             UNION SELECT 1 FROM anteile WHERE teilnehmer_id=?""", (tid, tid, tid)).fetchone()
    if benutzt:
        raise Fehler(f"„{t['name']}“ hat schon Buchungen und kann nicht gelöscht werden. "
                     "Stattdessen „nicht mehr dabei“ setzen.", 409)
    if t["benutzer_id"] == ctx.p["ersteller_id"]:
        raise Fehler("Der Projektersteller kann nicht entfernt werden")
    con.execute("DELETE FROM teilnehmer WHERE id=?", (tid,))
    log(t["projekt_id"], f"Teilnehmer „{t['name']}“ entfernt")
    con.commit()
    return jsonify({"ok": True})


# ================================================================ Ausgaben & Zahlungen
def ausgabe_felder(ctx, data):
    con = db()
    tns = {r["id"]: r for r in con.execute("SELECT * FROM teilnehmer WHERE projekt_id=?", (ctx.p["id"],))}
    art = data.get("art", "ausgabe")
    if art not in ("ausgabe", "zahlung"):
        raise Fehler("Ungültige Art")
    zahler = as_int(data.get("zahler_id"), "Zahler")
    if zahler not in tns:
        raise Fehler("Wer hat bezahlt? Bitte auswählen.")
    f = {"art": art, "betrag": parse_betrag(data.get("betrag")), "zahler_id": zahler,
         "datum": parse_datum(data.get("datum") or heute()), "notiz": text(data, "notiz", 500),
         "empfaenger_id": None, "anteile": []}
    if art == "zahlung":
        emp = as_int(data.get("empfaenger_id"), "Empfänger")
        if emp not in tns or emp == zahler:
            raise Fehler("Empfänger ungültig")
        f["empfaenger_id"] = emp
        f["beschreibung"] = text(data, "beschreibung", 120) or "Ausgleich"
        f["kategorie"] = "ausgleich"
    else:
        f["beschreibung"] = text(data, "beschreibung", 120, pflicht=True, name="Wofür")
        kat = data.get("kategorie") or "sonstiges"
        f["kategorie"] = kat if kat in KATEGORIEN else "sonstiges"
        seen = set()
        for x in data.get("anteile") or []:
            tid = as_int(x.get("teilnehmer_id") if isinstance(x, dict) else x, "Teilnehmer")
            w = as_int(x.get("gewicht", tns.get(tid, {"gewicht": 1})["gewicht"]) if isinstance(x, dict) else 1,
                       "Gewichtung")
            if tid not in tns:
                raise Fehler("Unbekannter Teilnehmer in der Aufteilung")
            if not 1 <= w <= 20:
                raise Fehler("Gewichtung muss zwischen 1 und 20 liegen")
            if tid not in seen:
                seen.add(tid)
                f["anteile"].append((tid, w))
        if not f["anteile"]:
            raise Fehler("Auf wen wird aufgeteilt? Mindestens eine Person auswählen.")
    if not ctx.darf_fuer(f["zahler_id"], f["empfaenger_id"]):
        raise Fehler("Du darfst nur Ausgaben eintragen, die du selbst bezahlt hast"
                     if ctx.stufe("r_eintragen") == "selbst" else "Du darfst hier nichts eintragen", 403)
    f["_tns"] = tns
    return f


def beschreibe(f, waehrung="€"):
    tns = f["_tns"]
    if f["art"] == "zahlung":
        return (f"Ausgleich {tns[f['zahler_id']]['name']} → {tns[f['empfaenger_id']]['name']} "
                f"über {euro(f['betrag'], waehrung)}")
    return f"„{f['beschreibung']}“ ({euro(f['betrag'], waehrung)}, bezahlt von {tns[f['zahler_id']]['name']})"


@app.post("/api/projekte/<int:pid>/ausgaben")
@login_noetig
def ausgabe_neu(pid):
    ctx = lade_ctx(pid)
    if ctx.gesperrt:
        raise Fehler("Projekt ist abgeschlossen", 403)
    f = ausgabe_felder(ctx, request.get_json(silent=True) or {})
    con = db()
    aid = con.execute("""INSERT INTO ausgaben (projekt_id,art,beschreibung,kategorie,betrag,datum,zahler_id,
                         empfaenger_id,notiz,erstellt_von,erstellt) VALUES (?,?,?,?,?,?,?,?,?,?,?)""",
                      (pid, f["art"], f["beschreibung"], f["kategorie"], f["betrag"], f["datum"],
                       f["zahler_id"], f["empfaenger_id"], f["notiz"], ctx.u["id"], jetzt())).lastrowid
    con.executemany("INSERT INTO anteile (ausgabe_id,teilnehmer_id,gewicht) VALUES (?,?,?)",
                    [(aid, t, w) for t, w in f["anteile"]])
    log(pid, ("Eingetragen: " if f["art"] == "ausgabe" else "") + beschreibe(f, ctx.p["waehrung"]))
    con.commit()
    return jsonify({"ok": True, "id": aid})


def lade_ausgabe(aid):
    a = db().execute("SELECT * FROM ausgaben WHERE id=?", (aid,)).fetchone()
    if not a:
        abort(404)
    return a


@app.put("/api/ausgaben/<int:aid>")
@login_noetig
def ausgabe_aendern(aid):
    a = lade_ausgabe(aid)
    ctx = lade_ctx(a["projekt_id"])
    if not ctx.darf("r_bearbeiten", a):
        raise Fehler("Du darfst diesen Eintrag nicht bearbeiten", 403)
    data = request.get_json(silent=True) or {}
    data["art"] = a["art"]
    f = ausgabe_felder(ctx, data)
    con = db()
    con.execute("""UPDATE ausgaben SET beschreibung=?,kategorie=?,betrag=?,datum=?,zahler_id=?,empfaenger_id=?,
                   notiz=?,geaendert=? WHERE id=?""",
                (f["beschreibung"], f["kategorie"], f["betrag"], f["datum"], f["zahler_id"],
                 f["empfaenger_id"], f["notiz"], jetzt(), aid))
    con.execute("DELETE FROM anteile WHERE ausgabe_id=?", (aid,))
    con.executemany("INSERT INTO anteile (ausgabe_id,teilnehmer_id,gewicht) VALUES (?,?,?)",
                    [(aid, t, w) for t, w in f["anteile"]])
    alt = euro(a["betrag"], ctx.p["waehrung"])
    log(a["projekt_id"], "Geändert: " + beschreibe(f, ctx.p["waehrung"]) + (f" – vorher {alt}" if a["betrag"] != f["betrag"] else ""))
    con.commit()
    return jsonify({"ok": True})


@app.delete("/api/ausgaben/<int:aid>")
@login_noetig
def ausgabe_loeschen(aid):
    a = lade_ausgabe(aid)
    ctx = lade_ctx(a["projekt_id"])
    if not ctx.darf("r_loeschen", a):
        raise Fehler("Du darfst diesen Eintrag nicht löschen", 403)
    con = db()
    tns = {r["id"]: r for r in con.execute("SELECT * FROM teilnehmer WHERE projekt_id=?", (a["projekt_id"],))}
    f = dict(a) | {"_tns": tns}
    con.execute("DELETE FROM anteile WHERE ausgabe_id=?", (aid,))
    con.execute("DELETE FROM ausgaben WHERE id=?", (aid,))
    log(a["projekt_id"], "Gelöscht: " + beschreibe(f, ctx.p["waehrung"]))
    con.commit()
    return jsonify({"ok": True})


# ================================================================ Export
@app.get("/api/projekte/<int:pid>/export.csv")
@login_noetig
def export_csv(pid):
    ctx = lade_ctx(pid)
    d = projekt_daten(pid)
    w = ctx.p["waehrung"]
    namen = {t["id"]: t["name"] for t in d["teilnehmer"]}
    zahl = lambda c: f"{c / 100:.2f}".replace(".", ",")
    buf = io.StringIO()
    out = csv.writer(buf, delimiter=";")
    out.writerow([f"Urlaubskasse – {ctx.p['name']}"])
    out.writerow([])
    out.writerow(["Datum", "Art", "Wofür", "Kategorie", "Bezahlt von", "An", f"Betrag ({w})",
                  "Aufgeteilt auf", "Notiz"])
    for a in sorted(d["ausgaben"], key=lambda x: (x["datum"], x["id"])):
        auf = ", ".join(namen[x["teilnehmer_id"]] + (f" ×{x['gewicht']}" if x["gewicht"] != 1 else "")
                        for x in a["anteile"])
        out.writerow([date.fromisoformat(a["datum"]).strftime("%d.%m.%Y"),
                      "Ausgabe" if a["art"] == "ausgabe" else "Ausgleichszahlung",
                      a["beschreibung"], KATEGORIEN.get(a["kategorie"], "").split(" ", 1)[-1],
                      namen[a["zahler_id"]], namen.get(a["empfaenger_id"], ""), zahl(a["betrag"]), auf, a["notiz"]])
    out.writerow([])
    out.writerow(["Person", f"Bezahlt ({w})", f"Anteil ({w})", f"Ausgleich gezahlt ({w})",
                  f"Ausgleich erhalten ({w})", f"Saldo ({w})"])
    for t in d["teilnehmer"]:
        out.writerow([t["name"], zahl(t["bezahlt"]), zahl(t["anteil"]), zahl(t["gezahlt"]),
                      zahl(t["erhalten"]), zahl(t["saldo"])])
    out.writerow(["Gesamt", zahl(d["auswertung"]["gesamt"])])
    out.writerow([])
    out.writerow(["Noch offen: wer zahlt wem"])
    for x in d["auswertung"]["ausgleich"]:
        out.writerow([namen[x["von"]], "→", namen[x["an"]], zahl(x["betrag"])])
    name = "".join(c if c.isalnum() or c in "-_" else "_" for c in ctx.p["name"])[:40] or "projekt"
    return Response("﻿" + buf.getvalue(), mimetype="text/csv; charset=utf-8",
                    headers={"Content-Disposition": f'attachment; filename="urlaubskasse_{name}.csv"'})


# ================================================================ Seiten
@app.get("/")
def index():
    resp = send_from_directory(BASE / "static", "index.html")
    resp.headers["Cache-Control"] = "no-cache"
    return resp


@app.get("/static/<path:name>")
def statisch(name):
    resp = send_from_directory(BASE / "static", name)
    resp.headers["Cache-Control"] = "no-cache"
    return resp


@app.after_request
def sicherheits_header(resp):
    resp.headers.setdefault("X-Content-Type-Options", "nosniff")
    resp.headers.setdefault("X-Frame-Options", "DENY")
    resp.headers.setdefault("Referrer-Policy", "same-origin")
    if request.path.startswith("/api/"):
        resp.headers["Cache-Control"] = "no-store"
    return resp


# ================================================================ Kommandozeile
def cli_admin(login):
    """`urlaubskasse-admin <login>`: Admin anlegen oder Passwort zurücksetzen."""
    import getpass
    init_db()
    pw = getpass.getpass(f"Neues Passwort für {login}: ")
    if pw != getpass.getpass("Wiederholen: "):
        sys.exit("Passwörter stimmen nicht überein.")
    if len(pw) < 6:
        sys.exit("Mindestens 6 Zeichen.")
    con = sqlite3.connect(DB_PATH)
    row = con.execute("SELECT id FROM benutzer WHERE login=? COLLATE NOCASE", (login,)).fetchone()
    if row:
        con.execute("UPDATE benutzer SET pw_hash=?, pw_version=pw_version+1, aktiv=1, admin=1 WHERE id=?",
                    (generate_password_hash(pw), row[0]))
        print(f"Passwort für „{login}“ gesetzt, Admin-Rechte aktiv.")
    else:
        con.execute("INSERT INTO benutzer (login,name,pw_hash,admin,darf_projekte,erstellt) VALUES (?,?,?,1,1,?)",
                    (login, login, generate_password_hash(pw), jetzt()))
        print(f"Admin „{login}“ angelegt.")
    con.commit()
    con.close()


def main():
    if len(sys.argv) >= 3 and sys.argv[1] == "--admin":
        return cli_admin(pruefe_login(sys.argv[2]))
    init_db()
    port = int(os.environ.get("URLAUB_PORT", "80"))
    if os.environ.get("URLAUB_DEV") == "1":
        app.run(host="0.0.0.0", port=port, debug=True)
    else:
        from waitress import serve
        print(f"Urlaubskasse läuft auf Port {port}", flush=True)
        serve(app, host="0.0.0.0", port=port, threads=8, ident="urlaubskasse")


if __name__ == "__main__":
    main()
