"use strict";
/* Urlaubskasse – Oberfläche. by Daniel Henk */

const $ = (s, el = document) => el.querySelector(s);
const $$ = (s, el = document) => [...el.querySelectorAll(s)];
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) =>
  ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);

const S = {
  status: null,     // /api/status
  user: null,
  kat: {},          // Kategorien
  pid: null,
  tab: "ausgaben",
  d: null,          // Projektdaten (/api/projekte/<id>)
  suche: "",
  filter: "",
  namen: null,      // Benutzer-Auswahlliste
};

// ------------------------------------------------------------------ Hilfen
async function api(method, url, body) {
  const opt = { method, credentials: "same-origin", headers: {} };
  if (method !== "GET") {
    opt.headers["Content-Type"] = "application/json";
    opt.body = JSON.stringify(body ?? {});
  }
  const r = await fetch(url, opt);
  let data = null;
  try { data = await r.json(); } catch { /* leer */ }
  if (r.status === 401 && !url.endsWith("/login") && !url.endsWith("/konto/passwort")) {
    S.user = null;
    zeigeLogin();
    throw new Error("Bitte neu anmelden");
  }
  if (!r.ok) throw new Error((data && data.fehler) || `Fehler ${r.status}`);
  return data;
}

let toastTimer;
function toast(msg, fehler = false) {
  const t = $("#toast");
  t.textContent = msg;
  t.className = "toast" + (fehler ? " fehler" : "");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.add("hidden"), fehler ? 4500 : 2200);
}

const W = () => (S.d && S.d.projekt.waehrung) || "€";
function geld(c, w = W()) {
  return (c / 100).toLocaleString("de-DE", { minimumFractionDigits: 2, maximumFractionDigits: 2 }) + " " + w;
}
function datumDE(iso, mitTag = false) {
  if (!iso) return "";
  const d = new Date(iso + "T12:00:00");
  return d.toLocaleDateString("de-DE", mitTag
    ? { weekday: "short", day: "2-digit", month: "2-digit", year: "numeric" }
    : { day: "2-digit", month: "2-digit", year: "numeric" });
}
function zeitraum(von, bis) {
  if (von && bis) return von === bis ? datumDE(von) : `${datumDE(von)} – ${datumDE(bis)}`;
  if (von) return `ab ${datumDE(von)}`;
  if (bis) return `bis ${datumDE(bis)}`;
  return "";
}
function parseBetrag(s) {
  s = String(s ?? "").trim().replace(/€|\s/g, "");
  if (!s) return NaN;
  if (s.includes(",") && s.includes(".")) s = s.replace(/\./g, "").replace(",", ".");
  else s = s.replace(",", ".");
  if (!/^\d*\.?\d*$/.test(s)) return NaN;
  return Math.round(parseFloat(s) * 100);
}
function heute() {
  const d = new Date();
  return new Date(d.getTime() - d.getTimezoneOffset() * 60000).toISOString().slice(0, 10);
}
function katIcon(k) { return k === "ausgleich" ? "💸" : (S.kat[k] || "📦").split(" ")[0]; }
function katName(k) { return k === "ausgleich" ? "Ausgleich" : (S.kat[k] || "Sonstiges").split(" ").slice(1).join(" "); }

/** Wie auf dem Server: Betrag nach Gewichten aufteilen, Rest-Cents gerecht. */
function verteilen(betrag, gewichte) {
  const total = gewichte.reduce((s, [, w]) => s + w, 0);
  const teile = {}; const reste = [];
  if (!total) return teile;
  for (const [tid, w] of gewichte) {
    teile[tid] = Math.floor((betrag * w) / total);
    reste.push([(betrag * w) % total, tid]);
  }
  let rest = betrag - Object.values(teile).reduce((a, b) => a + b, 0);
  reste.sort((a, b) => b[0] - a[0] || a[1] - b[1]);
  for (let i = 0; i < rest; i++) teile[reste[i][1]] += 1;
  return teile;
}

async function kopieren(text) {
  try {
    if (navigator.clipboard && window.isSecureContext) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch { /* Fallback unten */ }
  const ta = document.createElement("textarea");
  ta.value = text; ta.style.position = "fixed"; ta.style.opacity = "0";
  document.body.appendChild(ta); ta.focus(); ta.select();
  let ok = false;
  try { ok = document.execCommand("copy"); } catch { ok = false; }
  ta.remove();
  return ok;
}

// ------------------------------------------------------------------ Dialog
function dialog(html, onSubmit, setup) {
  const dlg = $("#dlg");
  const f = $("#dlgForm");
  f.innerHTML = html;
  f.onsubmit = async (e) => {
    e.preventDefault();
    const btn = $("button[type=submit]", f);
    if (btn) btn.disabled = true;
    try {
      const weiter = await onSubmit(f);
      if (weiter !== false) dlg.close();
    } catch (err) {
      toast(err.message, true);
    } finally {
      if (btn) btn.disabled = false;
    }
  };
  $$("[data-close]", f).forEach((b) => (b.onclick = () => dlg.close()));
  if (setup) setup(f);
  dlg.showModal();
  const first = $("[autofocus]", f);
  if (first) setTimeout(() => first.focus(), 30);
}
const schliessen = () => $("#dlg").close();

// ------------------------------------------------------------------ Navigation
const VIEWS = ["viewLogin", "viewProjekte", "viewProjekt", "viewBenutzer", "viewKonto"];
function view(id) {
  VIEWS.forEach((v) => $("#" + v).classList.toggle("hidden", v !== id));
  window.scrollTo(0, 0);
}
function titel(text, zurueck = null) {
  $("#titel span").textContent = text;
  document.title = text === "Urlaubskasse" ? text : `${text} – Urlaubskasse`;
  const b = $("#btnZurueck");
  b.classList.toggle("hidden", !zurueck);
  b.onclick = () => (location.hash = zurueck || "#/");
}

async function route() {
  $("#menu").classList.add("hidden");
  if (!S.user) return zeigeLogin();
  const h = location.hash.replace(/^#/, "") || "/";
  const m = h.match(/^\/p\/(\d+)(?:\/(\w+))?/);
  try {
    if (m) return await zeigeProjekt(+m[1], m[2] || "ausgaben");
    if (h === "/benutzer" && S.user.admin) return await zeigeBenutzer();
    if (h === "/konto") return zeigeKonto();
    return await zeigeProjekte();
  } catch (err) {
    toast(err.message, true);
    if (m) location.hash = "#/";
  }
}
window.addEventListener("hashchange", route);

// ------------------------------------------------------------------ Start / Login
async function start() {
  S.status = await api("GET", "/api/status");
  S.kat = S.status.kategorien;
  S.user = S.status.benutzer;
  fuss();
  if (!S.user) return zeigeLogin();
  angemeldet();
  route();
}

function fuss() {
  const s = S.status || {};
  $("#fuss").innerHTML = `Urlaubskasse ${esc(s.version || "")}` +
    (s.datum ? ` vom ${esc(datumDE(s.datum))}` : "") +
    (s.update ? ` · Update ${esc(s.update)}` : "") + ` · © by Daniel Henk` +
    (S.user && S.user.admin ? ` · <a href="#" id="fussUpdate">⟳ Update</a>` : "");
  const b = $("#fussUpdate");
  if (b) b.onclick = (e) => { e.preventDefault(); updateDialog(); };
}

// ------------------------------------------------------------------ Update (Admin)
async function updateDialog() {
  let st;
  try { st = await api("GET", "/api/update"); } catch (err) { return toast(err.message, true); }
  const versionAlt = st.version;
  let timer = null;
  const stop = () => { clearInterval(timer); timer = null; };

  // Status abfragen, Neustart des Dienstes (keine Antwort) aushalten
  function beobachten(f, log) {
    let fehler = 0, fertigSeit = 0;
    stop();
    timer = setInterval(async () => {
      let s;
      try {
        const r = await fetch("/api/update", { credentials: "same-origin", cache: "no-store" });
        if (r.status === 401) { stop(); location.reload(); return; }
        s = await r.json();
        fehler = 0;
      } catch {
        fehler++;
        if (fehler === 1) log.textContent += "\n(Dienst startet neu …)";
        if (fehler > 40) { stop(); log.textContent += "\nKeine Antwort – bitte Seite neu laden."; }
        return;
      }
      if (s.log) { log.classList.remove("hidden"); log.textContent = s.log; log.scrollTop = log.scrollHeight; }
      if (!s.laeuft && s.log && ++fertigSeit >= 2) {
        stop();
        const neu = s.version !== versionAlt;
        f.updGo.textContent = neu ? `Fertig: ${s.version}` : "Fertig";
        toast(neu ? `Aktualisiert auf ${s.version}` : "Update durchgelaufen");
        setTimeout(() => location.reload(), 1500);
      }
    }, 1500);
  }

  dialog(`
    <h3>⟳ Update einspielen</h3>
    <p class="muted small" style="margin:0">Holt die neueste Version aus Gitea und startet den Dienst neu.
      Dauert ein paar Sekunden, die Seite ist kurz nicht erreichbar.</p>
    <div class="info">Installiert: <b>${esc(st.version)}</b>${st.update ? ` · letztes Update ${esc(st.update)}` : ""}</div>
    ${st.verfuegbar ? "" : `<div class="hinweis">Update-Dienst noch nicht eingerichtet. Einmal in der Shell
      <code>urlaubskasse-update --force</code> ausführen – danach geht es hier per Klick.</div>`}
    <pre id="updLog" class="log ${st.log ? "" : "hidden"}">${esc(st.log)}</pre>
    ${st.log_zeit && !st.laeuft ? `<p class="muted small" style="margin:0">Letztes Protokoll vom ${esc(st.log_zeit)}</p>` : ""}
    <div class="dlg-actions">
      <button type="button" class="btn" data-close>Schließen</button>
      <button type="submit" class="btn primary" name="updGo" ${st.verfuegbar && !st.laeuft ? "" : "disabled"}>${st.laeuft ? "Läuft …" : "Jetzt aktualisieren"}</button>
    </div>`,
  async (f) => {
    await api("POST", "/api/update");
    f.updGo.disabled = true; f.updGo.textContent = "Läuft …";
    const log = $("#updLog", f);
    log.classList.remove("hidden"); log.textContent = "Update angefordert, warte auf den Dienst …";
    beobachten(f, log);
    return false;
  },
  (f) => {
    $("#dlg").addEventListener("close", stop, { once: true });
    if (st.laeuft) beobachten(f, $("#updLog", f));
  });
}

function angemeldet() {
  $("#menuWrap").classList.remove("hidden");
  $("#menuUser").innerHTML = `Angemeldet als <b>${esc(S.user.name)}</b> (${esc(S.user.login)})` +
    (S.user.admin ? ' <span class="tag">Admin</span>' : "");
  $("#menuBenutzer").classList.toggle("hidden", !S.user.admin);
  $("#menuUpdate").classList.toggle("hidden", !S.user.admin);
  $("#menuUpdate").onclick = () => { $("#menu").classList.add("hidden"); updateDialog(); };
  fuss();
}

function zeigeLogin() {
  const setup = S.status && S.status.setup_noetig;
  $("#menuWrap").classList.add("hidden");
  titel("Urlaubskasse");
  view("viewLogin");
  const f = $("#formLogin");
  $("#loginTitel").textContent = setup ? "Einrichtung" : "Anmelden";
  $("#loginText").textContent = setup
    ? "Erster Start: Lege dein Admin-Konto an."
    : "Melde dich mit deinem Benutzernamen an.";
  $("#btnLogin").textContent = setup ? "Admin anlegen" : "Anmelden";
  f.name.classList.toggle("hidden", !setup);
  f.passwort2.classList.toggle("hidden", !setup);
  f.passwort.autocomplete = setup ? "new-password" : "current-password";
  $("#loginErr").textContent = "";
}

$("#formLogin").addEventListener("submit", async (e) => {
  e.preventDefault();
  const f = e.target;
  const setup = S.status && S.status.setup_noetig;
  $("#loginErr").textContent = "";
  try {
    if (setup) {
      if (f.passwort.value !== f.passwort2.value) throw new Error("Passwörter stimmen nicht überein");
      await api("POST", "/api/setup", { login: f.login.value, name: f.name.value, passwort: f.passwort.value });
    } else {
      await api("POST", "/api/login", { login: f.login.value, passwort: f.passwort.value });
    }
    f.passwort.value = ""; f.passwort2.value = "";
    await start();
  } catch (err) {
    $("#loginErr").textContent = err.message;
  }
});

$("#btnMenu").onclick = (e) => { e.stopPropagation(); $("#menu").classList.toggle("hidden"); };
document.addEventListener("click", (e) => { if (!e.target.closest("#menuWrap")) $("#menu").classList.add("hidden"); });
$("#btnLogout").onclick = async () => {
  await api("POST", "/api/logout").catch(() => {});
  S.user = null; S.d = null;
  location.hash = "#/";
  start();
};

// ------------------------------------------------------------------ Projektliste
async function zeigeProjekte() {
  titel("Urlaubskasse");
  S.d = null;
  const liste = await api("GET", "/api/projekte");
  view("viewProjekte");
  $("#btnProjektNeu").classList.toggle("hidden", !S.user.darf_projekte);
  const el = $("#projektListe");
  if (!liste.length) {
    el.innerHTML = `<div class="leer">🏝️<br>Noch keine Projekte.<br>` +
      (S.user.darf_projekte ? "Leg mit „＋ Neues Projekt“ deinen ersten Urlaub oder Ausflug an."
        : "Sobald dich jemand zu einem Projekt hinzufügt, erscheint es hier.") + `</div>`;
    return;
  }
  el.innerHTML = liste.map((p) => {
    let saldo = "";
    if (p.mein_saldo !== null) {
      saldo = p.mein_saldo > 0 ? `<span class="tag gruen">du bekommst ${geld(p.mein_saldo, p.waehrung)}</span>`
        : p.mein_saldo < 0 ? `<span class="tag rot">du zahlst ${geld(-p.mein_saldo, p.waehrung)}</span>`
          : `<span class="tag grau">ausgeglichen</span>`;
    }
    return `<div class="item click${p.abgeschlossen ? " aus" : ""}" data-id="${p.id}">
      <div class="ico">${p.abgeschlossen ? "✅" : "🧳"}</div>
      <div class="main">
        <div class="t">${esc(p.name)} ${p.abgeschlossen ? '<span class="tag grau">abgeschlossen</span>' : ""}</div>
        <div class="s">${esc(zeitraum(p.von, p.bis) || "ohne Datum")} · ${p.anzahl_teilnehmer} Personen · ${p.anzahl_ausgaben} Ausgaben</div>
        <div style="margin-top:4px">${saldo}</div>
      </div>
      <div class="r"><b class="num">${geld(p.gesamt, p.waehrung)}</b><div class="s">gesamt</div></div>
    </div>`;
  }).join("");
  $$(".item", el).forEach((it) => (it.onclick = () => (location.hash = `#/p/${it.dataset.id}`)));
}

function projektDialog(p = null) {
  const neu = !p;
  p = p || { name: "", beschreibung: "", von: "", bis: "", waehrung: "€" };
  dialog(`
    <h3>${neu ? "🧳 Neues Projekt" : "Projekt bearbeiten"}</h3>
    <label>Name<input name="name" value="${esc(p.name)}" placeholder="z. B. Mallorca 2027, Tagesausflug Phantasialand" maxlength="80" required autofocus></label>
    <label>Beschreibung (optional)<input name="beschreibung" value="${esc(p.beschreibung)}" maxlength="500"></label>
    <div class="row">
      <label>Von<input type="date" name="von" value="${esc(p.von || "")}"></label>
      <label>Bis<input type="date" name="bis" value="${esc(p.bis || "")}"></label>
      <label style="flex:.5">Währung<input name="waehrung" value="${esc(p.waehrung)}" maxlength="5"></label>
    </div>
    ${neu ? `
      <label class="check"><input type="checkbox" name="mitmachen" checked> Ich bin selbst dabei</label>
      <label>Weitere Teilnehmer (optional, einer pro Zeile)
        <textarea name="teilnehmer" placeholder="Anna&#10;Ben&#10;Familie Müller"></textarea></label>
      <p class="muted small" style="margin:0">Teilnehmer, Gewichtung (z. B. Familie = 4 Personen) und Rechte kannst du später unter „Teilnehmer“ ändern.</p>` : ""}
    <div class="dlg-actions">
      <button type="button" class="btn" data-close>Abbrechen</button>
      <button type="submit" class="btn primary">${neu ? "Anlegen" : "Speichern"}</button>
    </div>`,
  async (f) => {
    const body = { name: f.name.value, beschreibung: f.beschreibung.value, von: f.von.value,
      bis: f.bis.value, waehrung: f.waehrung.value };
    if (neu) {
      body.mitmachen = f.mitmachen.checked;
      body.teilnehmer = f.teilnehmer.value.split("\n").map((s) => s.trim()).filter(Boolean);
      const r = await api("POST", "/api/projekte", body);
      toast("Projekt angelegt");
      location.hash = `#/p/${r.id}/teilnehmer`;
    } else {
      await api("PUT", `/api/projekte/${S.pid}`, body);
      toast("Gespeichert");
      await ladeProjekt();
    }
  });
}
$("#btnProjektNeu").onclick = () => projektDialog();

// ------------------------------------------------------------------ Projekt
async function ladeProjekt() {
  S.d = await api("GET", `/api/projekte/${S.pid}`);
  renderProjekt();
}

async function zeigeProjekt(pid, tab) {
  if (S.pid !== pid) { S.suche = ""; S.filter = ""; S.d = null; }
  S.pid = pid;
  S.tab = ["ausgaben", "auswertung", "teilnehmer", "verlauf"].includes(tab) ? tab : "ausgaben";
  S.d = await api("GET", `/api/projekte/${pid}`);
  view("viewProjekt");
  renderProjekt();
}

function renderProjekt() {
  const { projekt: p } = S.d;
  titel(p.name, "#/");
  const zr = zeitraum(p.von, p.bis);
  $("#projKopf").innerHTML =
    `<div class="sub">${esc([zr, p.beschreibung].filter(Boolean).join(" · "))}` +
    `${p.abgeschlossen ? ' <span class="tag grau">abgeschlossen</span>' : ""}</div>`;
  $$("#tabs button").forEach((b) => {
    b.classList.toggle("active", b.dataset.tab === S.tab);
    b.onclick = () => (location.hash = `#/p/${S.pid}/${b.dataset.tab}`);
  });
  ({ ausgaben: renderAusgaben, auswertung: renderAuswertung, teilnehmer: renderTeilnehmer,
    verlauf: renderVerlauf })[S.tab]();
}

const tnName = (id) => (S.d.teilnehmer.find((t) => t.id === id) || { name: "?" }).name;
const ich = () => S.d.rechte.teilnehmer_id;

function darfFuer(von, an = null) {
  const r = S.d.rechte;
  if (r.r_eintragen === "alle") return true;
  return r.r_eintragen === "selbst" && r.teilnehmer_id != null && [von, an].includes(r.teilnehmer_id);
}
function kannEintragen() { return S.d.rechte.r_eintragen !== "nein"; }

// ---------------------------------------------------------------- Tab: Ausgaben
function renderAusgaben() {
  const el = $("#tabInhalt");
  const { ausgaben, teilnehmer } = S.d;
  const optP = teilnehmer.map((t) => `<option value="${t.id}"${String(t.id) === S.filter ? " selected" : ""}>${esc(t.name)}</option>`).join("");
  el.innerHTML = `
    <div class="toolbar">
      <input type="search" id="suche" placeholder="Suchen …" value="${esc(S.suche)}">
      <select id="filterP"><option value="">Alle Personen</option>${optP}</select>
    </div>
    <div class="list" id="ausgabenListe"></div>
    ${kannEintragen() ? `<div class="fab-row">
      <button class="fab sek" id="btnZahlungNeu" title="Ausgleichszahlung eintragen">💸 Zahlung</button>
      <button class="fab" id="btnAusgabeNeu">＋ Ausgabe</button></div>` : ""}`;
  $("#suche").oninput = (e) => { S.suche = e.target.value; liste(); };
  $("#filterP").onchange = (e) => { S.filter = e.target.value; liste(); };
  if (kannEintragen()) {
    $("#btnAusgabeNeu").onclick = () => ausgabeDialog();
    $("#btnZahlungNeu").onclick = () => zahlungDialog();
  }

  function liste() {
    const q = S.suche.trim().toLowerCase();
    const fid = S.filter ? +S.filter : null;
    const rows = ausgaben.filter((a) => {
      if (fid && a.zahler_id !== fid && a.empfaenger_id !== fid && !a.anteile.some((x) => x.teilnehmer_id === fid)) return false;
      if (!q) return true;
      return [a.beschreibung, a.notiz, tnName(a.zahler_id), a.empfaenger_id ? tnName(a.empfaenger_id) : "", katName(a.kategorie)]
        .join(" ").toLowerCase().includes(q);
    });
    const box = $("#ausgabenListe");
    if (!ausgaben.length) {
      box.innerHTML = `<div class="leer">💶<br>Noch keine Ausgaben.` +
        (kannEintragen() ? `<br>Mit „＋ Ausgabe“ geht's los.` : "") + `</div>`;
      return;
    }
    if (!rows.length) { box.innerHTML = `<div class="leer">Nichts gefunden.</div>`; return; }
    let html = "", tag = "";
    const anzahl = teilnehmer.length;
    for (const a of rows) {
      if (a.datum !== tag) { tag = a.datum; html += `<div class="datum-kopf">${esc(datumDE(a.datum, true))}</div>`; }
      if (a.art === "zahlung") {
        html += `<div class="item click zahlung" data-id="${a.id}">
          <div class="ico">💸</div>
          <div class="main"><div class="t">${esc(tnName(a.zahler_id))} → ${esc(tnName(a.empfaenger_id))}</div>
            <div class="s">${esc(a.beschreibung)}${a.notiz ? " · " + esc(a.notiz) : ""}</div></div>
          <div class="r"><b class="num">${geld(a.betrag)}</b></div></div>`;
        continue;
      }
      const auf = a.anteile.length === anzahl ? `alle (${anzahl})`
        : a.anteile.map((x) => tnName(x.teilnehmer_id)).join(", ");
      const mein = a.anteile.find((x) => x.teilnehmer_id === ich());
      html += `<div class="item click" data-id="${a.id}">
        <div class="ico" title="${esc(katName(a.kategorie))}">${katIcon(a.kategorie)}</div>
        <div class="main"><div class="t">${esc(a.beschreibung)}</div>
          <div class="s">bezahlt von <b>${esc(tnName(a.zahler_id))}</b> · für ${esc(auf)}${a.notiz ? " · " + esc(a.notiz) : ""}</div></div>
        <div class="r"><b class="num">${geld(a.betrag)}</b>
          ${mein ? `<div class="s num">dein Anteil ${geld(mein.betrag)}</div>` : ""}</div></div>`;
    }
    box.innerHTML = html;
    $$(".item", box).forEach((it) => (it.onclick = () => {
      const a = ausgaben.find((x) => x.id === +it.dataset.id);
      a.art === "zahlung" ? zahlungDialog(a) : ausgabeDialog(a);
    }));
  }
  liste();
}

function ausgabeDialog(a = null) {
  const neu = !a;
  const r = S.d.rechte;
  const nurLesen = !neu && !a.darf_bearbeiten;
  const tns = S.d.teilnehmer;
  const selbstNur = r.r_eintragen === "selbst";
  let kat = a ? a.kategorie : "essen";
  const zahler = a ? a.zahler_id : (ich() ?? (tns.find((t) => t.aktiv) || tns[0] || {}).id);
  const anteile = a ? Object.fromEntries(a.anteile.map((x) => [x.teilnehmer_id, x.gewicht]))
    : Object.fromEntries(tns.filter((t) => t.aktiv).map((t) => [t.id, t.gewicht]));
  const gewSichtbar = tns.some((t) => t.gewicht !== 1) || (a && a.anteile.some((x) => x.gewicht !== 1));
  if (!tns.length) { toast("Lege zuerst Teilnehmer an", true); location.hash = `#/p/${S.pid}/teilnehmer`; return; }
  const dis = nurLesen ? "disabled" : "";

  dialog(`
    <h3>${neu ? "＋ Neue Ausgabe" : nurLesen ? "Ausgabe" : "Ausgabe bearbeiten"}</h3>
    ${nurLesen ? `<div class="info">Nur ansehen – du darfst diesen Eintrag nicht bearbeiten.</div>` : ""}
    <div class="row">
      <label>Betrag (${esc(W())})<input name="betrag" class="betrag-input" inputmode="decimal" placeholder="0,00"
        value="${a ? (a.betrag / 100).toFixed(2).replace(".", ",") : ""}" ${dis} ${neu ? "autofocus" : ""} required></label>
      <label>Datum<input type="date" name="datum" value="${esc(a ? a.datum : heute())}" ${dis}></label>
    </div>
    <label>Wofür<input name="beschreibung" value="${esc(a ? a.beschreibung : "")}" placeholder="z. B. Abendessen, Eintritt, Tanken" maxlength="120" ${dis} required></label>
    <div class="kats" id="kats">${Object.entries(S.kat).map(([k, v]) =>
      `<button type="button" data-k="${k}" class="${k === kat ? "active" : ""}" ${dis}>${esc(v)}</button>`).join("")}</div>
    <label>Bezahlt von<select name="zahler" ${dis}>${tns.map((t) =>
      `<option value="${t.id}" ${t.id === zahler ? "selected" : ""} ${selbstNur && t.id !== ich() && !nurLesen ? "disabled" : ""}>${esc(t.name)}</option>`).join("")}</select></label>
    <div>
      <div class="auswahl-kopf"><span>Aufteilen auf</span>
        <span>${nurLesen ? "" : `<button type="button" id="alle">alle</button><button type="button" id="keiner">keiner</button>
        <button type="button" id="gewToggle">${gewSichtbar ? "Gewichte aus" : "Gewichte"}</button>`}</span></div>
      <div class="auswahl" id="auswahl">${tns.map((t) => `
        <div class="z">
          <label class="check"><input type="checkbox" data-t="${t.id}" ${anteile[t.id] ? "checked" : ""} ${dis}>
            ${esc(t.name)}${t.aktiv ? "" : ' <span class="tag grau">nicht mehr dabei</span>'}</label>
          <input type="number" class="gew ${gewSichtbar ? "" : "hidden"}" data-g="${t.id}" min="1" max="20" value="${anteile[t.id] || t.gewicht}" title="Gewichtung (Anzahl Personen)" ${dis}>
          <span class="je num" data-je="${t.id}"></span>
        </div>`).join("")}</div>
    </div>
    <label>Notiz (optional)<input name="notiz" value="${esc(a ? a.notiz : "")}" maxlength="500" ${dis}></label>
    ${a ? `<p class="muted small" style="margin:0">Eingetragen von ${esc(a.ersteller_name || "?")} am ${esc(a.erstellt.slice(0, 16).split(" ").map((x, i) => i ? x : datumDE(x)).join(" "))}${a.geaendert ? ", zuletzt geändert " + esc(a.geaendert.slice(0, 16).split(" ").map((x, i) => i ? x : datumDE(x)).join(" ")) : ""}</p>` : ""}
    <div class="dlg-actions">
      ${a && a.darf_loeschen ? `<button type="button" class="btn danger links" id="btnDel">🗑 Löschen</button>` : ""}
      <button type="button" class="btn" data-close>${nurLesen ? "Schließen" : "Abbrechen"}</button>
      ${nurLesen ? "" : `<button type="submit" class="btn primary">Speichern</button>`}
    </div>`,
  async (f) => {
    if (nurLesen) return;
    const betrag = parseBetrag(f.betrag.value);
    if (!(betrag > 0)) throw new Error("Bitte einen gültigen Betrag eingeben");
    const body = {
      betrag: (betrag / 100).toFixed(2), datum: f.datum.value, beschreibung: f.beschreibung.value,
      kategorie: kat, zahler_id: +f.zahler.value, notiz: f.notiz.value,
      anteile: $$("#auswahl input[type=checkbox]", f).filter((c) => c.checked).map((c) => ({
        teilnehmer_id: +c.dataset.t, gewicht: +$(`[data-g="${c.dataset.t}"]`, f).value || 1 })),
    };
    if (neu) await api("POST", `/api/projekte/${S.pid}/ausgaben`, body);
    else await api("PUT", `/api/ausgaben/${a.id}`, body);
    toast(neu ? "Ausgabe eingetragen" : "Gespeichert");
    await ladeProjekt();
  },
  (f) => {
    const vorschau = () => {
      const b = parseBetrag(f.betrag.value);
      const gew = $$("#auswahl input[type=checkbox]", f).filter((c) => c.checked)
        .map((c) => [+c.dataset.t, Math.max(1, +$(`[data-g="${c.dataset.t}"]`, f).value || 1)]);
      const teile = b > 0 ? verteilen(b, gew) : {};
      $$("[data-je]", f).forEach((s) => (s.textContent = teile[s.dataset.je] != null ? geld(teile[s.dataset.je]) : ""));
    };
    f.addEventListener("input", vorschau);
    f.addEventListener("change", vorschau);
    vorschau();
    if (nurLesen) return;
    const katNamen = Object.keys(S.kat).map(katName);
    $$("#kats button", f).forEach((b) => (b.onclick = () => {
      kat = b.dataset.k;
      $$("#kats button", f).forEach((x) => x.classList.toggle("active", x === b));
      // „Wofür“ vorbelegen: wenn leer oder nur ein Kategoriename drinsteht
      // (z. B. „Essen“ oder „Essen “) – eigener Text wie „Essen Tapas-Bar“ bleibt.
      const w = f.beschreibung;
      const alt = w.value.trim();
      if (!alt || katNamen.includes(alt)) {
        w.value = katName(kat) + " ";
        w.focus();
        w.setSelectionRange(w.value.length, w.value.length);
      }
    }));
    $("#alle", f).onclick = () => { $$("#auswahl input[type=checkbox]", f).forEach((c) => (c.checked = true)); vorschau(); };
    $("#keiner", f).onclick = () => { $$("#auswahl input[type=checkbox]", f).forEach((c) => (c.checked = false)); vorschau(); };
    $("#gewToggle", f).onclick = (e) => {
      const an = $(".gew", f).classList.contains("hidden");
      $$(".gew", f).forEach((g) => g.classList.toggle("hidden", !an));
      e.target.textContent = an ? "Gewichte aus" : "Gewichte";
      if (!an) $$(".gew", f).forEach((g) => (g.value = 1));
      vorschau();
    };
    const del = $("#btnDel", f);
    if (del) del.onclick = () => loeschen(a);
  });
}

async function loeschen(a) {
  const was = a.art === "zahlung" ? `die Zahlung ${tnName(a.zahler_id)} → ${tnName(a.empfaenger_id)}` : `„${a.beschreibung}“`;
  if (!confirm(`${was} über ${geld(a.betrag)} wirklich löschen?`)) return;
  try {
    await api("DELETE", `/api/ausgaben/${a.id}`);
    schliessen();
    toast("Gelöscht");
    await ladeProjekt();
  } catch (err) { toast(err.message, true); }
}

function zahlungDialog(a = null, vorschlag = null) {
  const neu = !a;
  const nurLesen = !neu && !a.darf_bearbeiten;
  const dis = nurLesen ? "disabled" : "";
  const tns = S.d.teilnehmer;
  const v = a || vorschlag || {};
  const von = v.zahler_id ?? v.von ?? ich() ?? tns[0]?.id;
  const an = v.empfaenger_id ?? v.an ?? tns.find((t) => t.id !== von)?.id;
  const opts = (sel) => tns.map((t) => `<option value="${t.id}" ${t.id === sel ? "selected" : ""}>${esc(t.name)}</option>`).join("");
  dialog(`
    <h3>💸 ${neu ? "Ausgleichszahlung eintragen" : "Ausgleichszahlung"}</h3>
    <p class="muted small" style="margin:0">Geld, das jemand einem anderen direkt gegeben hat (bar, PayPal, Überweisung) – damit der Saldo stimmt.</p>
    <div class="row">
      <label>Wer hat gezahlt<select name="von" ${dis}>${opts(von)}</select></label>
      <label>An wen<select name="an" ${dis}>${opts(an)}</select></label>
    </div>
    <div class="row">
      <label>Betrag (${esc(W())})<input name="betrag" class="betrag-input" inputmode="decimal" placeholder="0,00"
        value="${v.betrag ? (v.betrag / 100).toFixed(2).replace(".", ",") : ""}" ${dis} required></label>
      <label>Datum<input type="date" name="datum" value="${esc(v.datum || heute())}" ${dis}></label>
    </div>
    <label>Notiz (optional)<input name="notiz" value="${esc(a ? a.notiz : "")}" placeholder="z. B. bar, PayPal" maxlength="500" ${dis}></label>
    <div class="dlg-actions">
      ${a && a.darf_loeschen ? `<button type="button" class="btn danger links" id="btnDel">🗑 Löschen</button>` : ""}
      <button type="button" class="btn" data-close>${nurLesen ? "Schließen" : "Abbrechen"}</button>
      ${nurLesen ? "" : `<button type="submit" class="btn primary">Speichern</button>`}
    </div>`,
  async (f) => {
    if (nurLesen) return;
    const betrag = parseBetrag(f.betrag.value);
    if (!(betrag > 0)) throw new Error("Bitte einen gültigen Betrag eingeben");
    const body = { art: "zahlung", zahler_id: +f.von.value, empfaenger_id: +f.an.value,
      betrag: (betrag / 100).toFixed(2), datum: f.datum.value, notiz: f.notiz.value, beschreibung: "Ausgleich" };
    if (neu) await api("POST", `/api/projekte/${S.pid}/ausgaben`, body);
    else await api("PUT", `/api/ausgaben/${a.id}`, body);
    toast("Zahlung eingetragen");
    await ladeProjekt();
  },
  (f) => { const del = $("#btnDel", f); if (del) del.onclick = () => loeschen(a); });
}

// ---------------------------------------------------------------- Tab: Auswertung
function renderAuswertung() {
  const { teilnehmer: tns, auswertung: aw, projekt: p } = S.d;
  const el = $("#tabInhalt");
  const mitAnteil = tns.filter((t) => t.anteil > 0);
  const schnitt = mitAnteil.length ? Math.round(aw.gesamt / mitAnteil.length) : 0;
  const gleich = mitAnteil.length > 0 && Math.max(...mitAnteil.map((t) => t.anteil)) - Math.min(...mitAnteil.map((t) => t.anteil)) <= mitAnteil.length;
  const maxAbs = Math.max(1, ...tns.map((t) => Math.abs(t.saldo)));
  const maxKat = Math.max(1, ...Object.values(aw.kategorien));
  const sum = (k) => tns.reduce((s, t) => s + t[k], 0);
  const hatAusgleich = tns.some((t) => t.gezahlt || t.erhalten);

  const transfers = aw.ausgleich.length ? aw.ausgleich.map((x, i) => `
      <div class="transfer">
        <div class="wer"><b>${esc(tnName(x.von))}</b> zahlt an <b>${esc(tnName(x.an))}</b></div>
        <div class="betrag num">${geld(x.betrag)}</div>
        ${!S.d.rechte.gesperrt && darfFuer(x.von, x.an) ? `<button class="btn small no-print" data-tr="${i}">✓ Erledigt</button>` : ""}
      </div>`).join("")
    : aw.gesamt ? `<div class="fertig">🎉 Alles ausgeglichen – niemand schuldet jemandem etwas.</div>`
      : `<div class="leer">Noch keine Ausgaben.</div>`;

  el.innerHTML = `
    <div class="kacheln">
      <div class="kachel"><div class="l">Gesamtausgaben</div><div class="v num">${geld(aw.gesamt)}</div></div>
      <div class="kachel"><div class="l">${gleich ? "Pro Person" : "Ø pro Person"}</div><div class="v num">${geld(gleich && mitAnteil.length ? mitAnteil[0].anteil : schnitt)}</div></div>
      <div class="kachel"><div class="l">Personen</div><div class="v">${tns.length}</div></div>
      <div class="kachel"><div class="l">Noch auszugleichen</div><div class="v num">${geld(aw.offen)}</div></div>
    </div>

    <div class="box">
      <h3>⚖️ So wird ausgeglichen</h3>
      ${transfers}
      ${aw.ausgleich.length ? `<p class="muted small" style="margin:6px 0 0">Mit „✓ Erledigt“ wird die Zahlung eingetragen – danach steht der Saldo auf 0.</p>` : ""}
    </div>

    <div class="box">
      <h3>👥 Wer hat was bezahlt</h3>
      <div class="scroll-x"><table class="tab">
        <thead><tr><th>Person</th><th>Bezahlt</th><th>Anteil</th>${hatAusgleich ? "<th>Ausgleich</th>" : ""}<th>Saldo</th></tr></thead>
        <tbody>${tns.map((t) => {
          const ausgl = t.gezahlt - t.erhalten;
          const w = (Math.abs(t.saldo) / maxAbs) * 50;
          return `<tr>
            <td>${esc(t.name)}${t.gewicht !== 1 ? ` <span class="tag grau">×${t.gewicht}</span>` : ""}
              <div class="saldo-bar"><i style="${t.saldo >= 0 ? `left:50%;width:${w}%;background:var(--green)` : `right:50%;width:${w}%;background:var(--red)`}"></i></div></td>
            <td class="num">${geld(t.bezahlt)}</td>
            <td class="num">${geld(t.anteil)}</td>
            ${hatAusgleich ? `<td class="num">${ausgl ? (ausgl > 0 ? "+" : "−") + geld(Math.abs(ausgl)) : "–"}</td>` : ""}
            <td class="num ${t.saldo > 0 ? "pos" : t.saldo < 0 ? "neg" : ""}"><b>${t.saldo > 0 ? "+" : t.saldo < 0 ? "−" : ""}${geld(Math.abs(t.saldo))}</b>
              <div class="small">${t.saldo > 0 ? "bekommt" : t.saldo < 0 ? "muss zahlen" : "ausgeglichen ✓"}</div></td></tr>`;
        }).join("")}</tbody>
        <tfoot><tr><td>Summe</td><td class="num">${geld(sum("bezahlt"))}</td><td class="num">${geld(sum("anteil"))}</td>${hatAusgleich ? "<td></td>" : ""}<td></td></tr></tfoot>
      </table></div>
      <p class="muted small" style="margin:8px 0 0"><b>Bezahlt</b> = was die Person ausgelegt hat · <b>Anteil</b> = was auf sie entfällt ·
        <b>Saldo</b> = Bezahlt − Anteil (+ Ausgleich). Plus heißt: bekommt Geld zurück.</p>
    </div>

    ${Object.keys(aw.kategorien).length ? `<div class="box">
      <h3>📊 Nach Kategorie</h3>
      ${Object.entries(aw.kategorien).map(([k, c]) => `
        <div class="balken"><span class="n">${katIcon(k)} ${esc(katName(k))}</span>
          <span class="b"><i style="width:${(c / maxKat) * 100}%"></i></span>
          <span class="w num">${geld(c)}</span></div>`).join("")}
    </div>` : ""}

    <div class="dlg-actions no-print" style="justify-content:flex-start">
      <button class="btn" id="btnText">📋 Als Text kopieren (WhatsApp)</button>
      <a class="btn" href="/api/projekte/${p.id}/export.csv">⬇ CSV / Excel</a>
      <button class="btn" onclick="window.print()">🖨 Drucken / PDF</button>
    </div>`;

  $$("[data-tr]", el).forEach((b) => (b.onclick = async () => {
    const x = aw.ausgleich[+b.dataset.tr];
    if (!confirm(`${tnName(x.von)} hat ${tnName(x.an)} ${geld(x.betrag)} gegeben?\nDie Zahlung wird eingetragen.`)) return;
    try {
      await api("POST", `/api/projekte/${S.pid}/ausgaben`, { art: "zahlung", zahler_id: x.von,
        empfaenger_id: x.an, betrag: (x.betrag / 100).toFixed(2), datum: heute(), beschreibung: "Ausgleich" });
      toast("Zahlung eingetragen");
      await ladeProjekt();
    } catch (err) { toast(err.message, true); }
  }));
  $("#btnText").onclick = async () => {
    const zeilen = [`🧳 ${p.name}${zeitraum(p.von, p.bis) ? " (" + zeitraum(p.von, p.bis) + ")" : ""}`,
      `Gesamt: ${geld(aw.gesamt)} · ${tns.length} Personen · ${gleich ? "pro Person" : "Ø"} ${geld(gleich && mitAnteil.length ? mitAnteil[0].anteil : schnitt)}`, "",
      "Bezahlt:", ...tns.map((t) => `• ${t.name}: ${geld(t.bezahlt)}`), ""];
    if (aw.ausgleich.length) zeilen.push("So gleichen wir aus:", ...aw.ausgleich.map((x) => `➡️ ${tnName(x.von)} zahlt an ${tnName(x.an)}: ${geld(x.betrag)}`));
    else zeilen.push("✅ Alles ausgeglichen");
    const txt = zeilen.join("\n").replace(/ /g, " ");
    if (await kopieren(txt)) toast("Text kopiert");
    else dialog(`<h3>Text</h3><textarea style="min-height:260px">${esc(txt)}</textarea>
      <div class="dlg-actions"><button type="button" class="btn" data-close>Schließen</button></div>`, () => {});
  };
}

// ---------------------------------------------------------------- Tab: Teilnehmer
const RECHT_TEXT = {
  r_eintragen: { nein: "nichts eintragen", selbst: "nur selbst Bezahltes eintragen", alle: "für alle eintragen" },
  r_bearbeiten: { nein: "nichts bearbeiten", eigene: "Eigenes bearbeiten", alle: "alles bearbeiten" },
  r_loeschen: { nein: "nichts löschen", eigene: "Eigenes löschen", alle: "alles löschen" },
};
const PRESETS = {
  lesen: { r_eintragen: "nein", r_bearbeiten: "nein", r_loeschen: "nein" },
  standard: { r_eintragen: "selbst", r_bearbeiten: "eigene", r_loeschen: "eigene" },
  alles: { r_eintragen: "alle", r_bearbeiten: "alle", r_loeschen: "alle" },
};

function renderTeilnehmer() {
  const { teilnehmer: tns, rechte: r, projekt: p } = S.d;
  const el = $("#tabInhalt");
  const rechteText = (t) => t.r_verwalten ? "Verwalter – darf alles"
    : [RECHT_TEXT.r_eintragen[t.r_eintragen], RECHT_TEXT.r_bearbeiten[t.r_bearbeiten], RECHT_TEXT.r_loeschen[t.r_loeschen]].join(", ");
  el.innerHTML = `
    ${r.voll ? "" : `<div class="info" style="margin-bottom:10px">Deine Rechte: ${esc([RECHT_TEXT.r_eintragen[r.r_eintragen], RECHT_TEXT.r_bearbeiten[r.r_bearbeiten], RECHT_TEXT.r_loeschen[r.r_loeschen]].join(", "))}${r.gesperrt ? " – Projekt ist abgeschlossen" : ""}.</div>`}
    <div class="list" id="tnListe">${tns.length ? tns.map((t) => `
      <div class="item ${r.voll ? "click" : ""} ${t.aktiv ? "" : "aus"}" data-id="${t.id}">
        <div class="ico">${t.benutzer_id ? "👤" : "🙂"}</div>
        <div class="main">
          <div class="t">${esc(t.name)}
            ${t.gewicht !== 1 ? `<span class="tag">×${t.gewicht} Personen</span>` : ""}
            ${t.benutzer_id === p.ersteller_id ? '<span class="tag">Ersteller</span>' : ""}
            ${t.aktiv ? "" : '<span class="tag grau">nicht mehr dabei</span>'}</div>
          <div class="s">${t.benutzer_id ? `Konto: ${esc(t.benutzer_login)} · ${esc(rechteText(t))}` : "ohne Konto – wird von anderen eingetragen"}</div>
        </div>
        <div class="r"><b class="num ${t.saldo > 0 ? "pos" : t.saldo < 0 ? "neg" : ""}">${t.saldo > 0 ? "+" : t.saldo < 0 ? "−" : ""}${geld(Math.abs(t.saldo))}</b>
          <div class="s">Saldo</div></div>
      </div>`).join("") : `<div class="leer">Noch keine Teilnehmer.</div>`}</div>
    ${r.voll ? `<div class="dlg-actions" style="justify-content:flex-start;margin:10px 0 18px">
      <button class="btn primary" id="btnTnNeu">＋ Teilnehmer</button></div>
    <div class="box">
      <h3>⚙️ Projekt</h3>
      <p class="muted small" style="margin:0 0 10px">${p.abgeschlossen
        ? "Das Projekt ist abgeschlossen. Teilnehmer ohne Verwalter-Rechte können nichts mehr ändern."
        : "Wenn alles bezahlt ist, kannst du das Projekt abschließen. Dann kann nur noch der Ersteller/Verwalter etwas ändern."}</p>
      <div class="dlg-actions" style="justify-content:flex-start">
        <button class="btn" id="btnProjEdit">✏️ Bearbeiten</button>
        <button class="btn" id="btnProjAbschl">${p.abgeschlossen ? "🔓 Wieder öffnen" : "✅ Abschließen"}</button>
        ${r.ersteller ? `<button class="btn danger" id="btnProjDel">🗑 Projekt löschen</button>` : ""}
      </div>
    </div>` : ""}`;
  if (!r.voll) return;
  $$("#tnListe .item", el).forEach((it) => (it.onclick = () => tnDialog(tns.find((t) => t.id === +it.dataset.id))));
  $("#btnTnNeu").onclick = () => tnDialog();
  $("#btnProjEdit").onclick = () => projektDialog(p);
  $("#btnProjAbschl").onclick = async () => {
    try {
      await api("PUT", `/api/projekte/${S.pid}`, { abgeschlossen: !p.abgeschlossen });
      toast(p.abgeschlossen ? "Projekt wieder geöffnet" : "Projekt abgeschlossen");
      await ladeProjekt();
    } catch (err) { toast(err.message, true); }
  };
  const del = $("#btnProjDel");
  if (del) del.onclick = async () => {
    const eingabe = prompt(`Projekt „${p.name}“ mit allen Ausgaben endgültig löschen?\nZum Bestätigen den Projektnamen eintippen:`);
    if (eingabe === null) return;
    if (eingabe.trim() !== p.name) return toast("Name stimmt nicht – nichts gelöscht", true);
    try {
      await api("DELETE", `/api/projekte/${S.pid}`);
      toast("Projekt gelöscht");
      location.hash = "#/";
    } catch (err) { toast(err.message, true); }
  };
}

async function tnDialog(t = null) {
  const neu = !t;
  const r = S.d.rechte;
  if (!S.namen) S.namen = await api("GET", "/api/benutzer/namen").catch(() => []);
  const vergeben = new Set(S.d.teilnehmer.filter((x) => x.benutzer_id && (!t || x.id !== t.id)).map((x) => x.benutzer_id));
  const v = t || { name: "", benutzer_id: null, gewicht: 1, aktiv: true, ...PRESETS.standard, r_verwalten: false };
  const istErsteller = t && t.benutzer_id === S.d.projekt.ersteller_id;
  const sel = (key) => `<select name="${key}" ${istErsteller ? "disabled" : ""}>${Object.entries(RECHT_TEXT[key]).map(([k, txt]) =>
    `<option value="${k}" ${v[key] === k ? "selected" : ""}>${esc(txt)}</option>`).join("")}</select>`;
  dialog(`
    <h3>${neu ? "＋ Teilnehmer" : "Teilnehmer bearbeiten"}</h3>
    <label>Name<input name="name" value="${esc(v.name)}" maxlength="60" placeholder="z. B. Anna oder Familie Müller" ${neu ? "autofocus" : ""}></label>
    <label>Benutzerkonto (optional)
      <select name="benutzer_id" ${istErsteller ? "disabled" : ""}>
        <option value="">– ohne Konto (nur Name) –</option>
        ${S.namen.map((b) => `<option value="${b.id}" ${b.id === v.benutzer_id ? "selected" : ""} ${vergeben.has(b.id) ? "disabled" : ""}>${esc(b.name)} (${esc(b.login)})${vergeben.has(b.id) ? " – schon dabei" : ""}</option>`).join("")}
      </select></label>
    <div class="row">
      <label>Gewichtung<input type="number" name="gewicht" min="1" max="20" value="${v.gewicht}"></label>
      <label class="check" style="align-self:end;padding-bottom:10px"><input type="checkbox" name="aktiv" ${v.aktiv ? "checked" : ""}> ist (noch) dabei</label>
    </div>
    <p class="muted small" style="margin:-4px 0 0">Gewichtung = für wie viele Personen jemand zahlt (Paar = 2, Familie = 4). Normal: 1.
      „Nicht mehr dabei“ = wird bei neuen Ausgaben nicht mehr automatisch ausgewählt.</p>
    <div id="rechteBox">
      <div class="auswahl-kopf" style="margin-bottom:6px"><span><b>Rechte</b> für dieses Konto</span></div>
      ${istErsteller ? `<div class="info">Projektersteller – darf immer alles.</div>` : `
      <div class="seg" id="presets" style="margin-bottom:10px">
        <button type="button" data-p="lesen">Nur ansehen</button>
        <button type="button" data-p="standard">Standard</button>
        <button type="button" data-p="alles">Alles</button>
      </div>
      <div class="rechte">
        <span>Eintragen</span>${sel("r_eintragen")}
        <span>Bearbeiten</span>${sel("r_bearbeiten")}
        <span>Löschen</span>${sel("r_loeschen")}
      </div>
      <label class="check" style="margin-top:10px"><input type="checkbox" name="r_verwalten" ${v.r_verwalten ? "checked" : ""} ${r.ersteller ? "" : "disabled"}>
        Verwalter (darf alles, auch Teilnehmer &amp; Rechte ändern)</label>
      <p class="muted small" style="margin:6px 0 0">„Eigenes“ = Einträge, die die Person selbst bezahlt oder selbst eingetragen hat.</p>`}
    </div>
    <div class="hinweis" id="ohneKonto">Ohne Konto kann sich die Person nicht anmelden – Ausgaben für sie trägst du (oder jemand mit „für alle eintragen“) ein.
      ${S.user.admin ? `Konten legst du unter <a href="#/benutzer">Benutzer verwalten</a> an.` : ""}</div>
    <div class="dlg-actions">
      ${!neu && !istErsteller ? `<button type="button" class="btn danger links" id="btnDel">Entfernen</button>` : ""}
      <button type="button" class="btn" data-close>Abbrechen</button>
      <button type="submit" class="btn primary">Speichern</button>
    </div>`,
  async (f) => {
    const body = { name: f.name.value, gewicht: +f.gewicht.value || 1, aktiv: f.aktiv.checked };
    if (!istErsteller) {
      body.benutzer_id = f.benutzer_id.value ? +f.benutzer_id.value : null;
      body.r_eintragen = f.r_eintragen.value;
      body.r_bearbeiten = f.r_bearbeiten.value;
      body.r_loeschen = f.r_loeschen.value;
      body.r_verwalten = f.r_verwalten.checked;
    }
    if (neu) await api("POST", `/api/projekte/${S.pid}/teilnehmer`, body);
    else await api("PUT", `/api/teilnehmer/${t.id}`, body);
    toast("Gespeichert");
    await ladeProjekt();
  },
  (f) => {
    const sync = () => {
      const konto = istErsteller || !!f.benutzer_id.value;
      $("#rechteBox", f).classList.toggle("hidden", !konto);
      $("#ohneKonto", f).classList.toggle("hidden", konto);
      if (!istErsteller) {
        const akt = Object.entries(PRESETS).find(([, pr]) => Object.entries(pr).every(([k, val]) => f[k].value === val));
        $$("#presets button", f).forEach((b) => b.classList.toggle("active", !!akt && akt[0] === b.dataset.p));
      }
    };
    if (!istErsteller) {
      f.benutzer_id.onchange = () => {
        if (!f.name.value.trim() && f.benutzer_id.value) {
          const b = S.namen.find((x) => x.id === +f.benutzer_id.value);
          if (b) f.name.value = b.name;
        }
        sync();
      };
      $$("#presets button", f).forEach((b) => (b.onclick = () => {
        Object.entries(PRESETS[b.dataset.p]).forEach(([k, val]) => (f[k].value = val));
        sync();
      }));
      $$(".rechte select", f).forEach((s) => (s.onchange = sync));
    }
    sync();
    const del = $("#btnDel", f);
    if (del) del.onclick = async () => {
      if (!confirm(`„${t.name}“ aus dem Projekt entfernen?`)) return;
      try {
        await api("DELETE", `/api/teilnehmer/${t.id}`);
        schliessen(); toast("Entfernt"); await ladeProjekt();
      } catch (err) { toast(err.message, true); }
    };
  });
}

// ---------------------------------------------------------------- Tab: Verlauf
async function renderVerlauf() {
  const el = $("#tabInhalt");
  el.innerHTML = `<div class="leer">Lade …</div>`;
  const rows = await api("GET", `/api/projekte/${S.pid}/verlauf`);
  el.innerHTML = rows.length ? `<div class="list">${rows.map((v) => `
    <div class="item"><div class="main"><div>${esc(v.text)}</div>
      <div class="s">${esc(datumDE(v.zeit.slice(0, 10)))} ${esc(v.zeit.slice(11, 16))} · ${esc(v.benutzer)}</div></div></div>`).join("")}</div>`
    : `<div class="leer">Noch nichts passiert.</div>`;
}

// ------------------------------------------------------------------ Benutzerverwaltung
async function zeigeBenutzer() {
  titel("Benutzer", "#/");
  const liste = await api("GET", "/api/benutzer");
  view("viewBenutzer");
  $("#benutzerListe").innerHTML = liste.map((b) => `
    <div class="item click ${b.aktiv ? "" : "aus"}" data-id="${b.id}">
      <div class="ico">${b.admin ? "⭐" : "👤"}</div>
      <div class="main"><div class="t">${esc(b.name)} <span class="muted small">(${esc(b.login)})</span>
        ${b.admin ? '<span class="tag">Admin</span>' : ""}${!b.admin && !b.darf_projekte ? '<span class="tag grau">keine eigenen Projekte</span>' : ""}
        ${b.aktiv ? "" : '<span class="tag rot">deaktiviert</span>'}</div>
        <div class="s">in ${b.mitglied} Projekt(en) · ${b.projekte} selbst angelegt</div></div>
    </div>`).join("");
  $$("#benutzerListe .item").forEach((it) => (it.onclick = () => benutzerDialog(liste.find((b) => b.id === +it.dataset.id))));
}
$("#btnBenutzerNeu").onclick = () => benutzerDialog();

function benutzerDialog(b = null) {
  const neu = !b;
  const selbst = b && b.id === S.user.id;
  dialog(`
    <h3>${neu ? "＋ Benutzer anlegen" : "Benutzer bearbeiten"}</h3>
    ${neu ? `<label>Benutzername (zum Anmelden)<input name="login" autocapitalize="off" maxlength="40" required autofocus></label>` : `<p class="muted" style="margin:0">Benutzername: <b>${esc(b.login)}</b></p>`}
    <label>Anzeigename<input name="name" value="${esc(b ? b.name : "")}" maxlength="60" placeholder="z. B. Anna"></label>
    <label>${neu ? "Passwort" : "Neues Passwort (leer lassen = unverändert)"}<input name="passwort" type="text" autocomplete="off" minlength="6" ${neu ? "required" : ""}></label>
    <label class="check"><input type="checkbox" name="darf_projekte" ${!b || b.darf_projekte ? "checked" : ""}> darf eigene Projekte anlegen</label>
    <label class="check"><input type="checkbox" name="admin" ${b && b.admin ? "checked" : ""} ${selbst ? "disabled" : ""}> Admin (sieht alle Projekte, verwaltet Benutzer)</label>
    ${neu ? "" : `<label class="check"><input type="checkbox" name="aktiv" ${b.aktiv ? "checked" : ""} ${selbst ? "disabled" : ""}> Konto aktiv (kann sich anmelden)</label>`}
    <div class="dlg-actions">
      ${!neu && !selbst ? `<button type="button" class="btn danger links" id="btnDel">Löschen</button>` : ""}
      <button type="button" class="btn" data-close>Abbrechen</button>
      <button type="submit" class="btn primary">Speichern</button>
    </div>`,
  async (f) => {
    const body = { name: f.name.value, darf_projekte: f.darf_projekte.checked, admin: f.admin.checked };
    if (f.passwort.value) body.passwort = f.passwort.value;
    if (neu) {
      body.login = f.login.value;
      await api("POST", "/api/benutzer", body);
      toast("Benutzer angelegt");
    } else {
      body.aktiv = selbst ? true : f.aktiv.checked;
      if (selbst) body.admin = true;
      await api("PUT", `/api/benutzer/${b.id}`, body);
      toast("Gespeichert");
    }
    S.namen = null;
    await zeigeBenutzer();
  },
  (f) => {
    const del = $("#btnDel", f);
    if (del) del.onclick = async () => {
      if (!confirm(`Benutzer „${b.name}“ löschen?\nTeilnehmer bleiben in den Projekten (ohne Konto) erhalten.`)) return;
      try {
        await api("DELETE", `/api/benutzer/${b.id}`);
        schliessen(); toast("Gelöscht"); S.namen = null; await zeigeBenutzer();
      } catch (err) { toast(err.message, true); }
    };
  });
}

// ------------------------------------------------------------------ Konto
function zeigeKonto() {
  titel("Mein Konto", "#/");
  view("viewKonto");
  $("#formName").name.value = S.user.name;
}
$("#formName").addEventListener("submit", async (e) => {
  e.preventDefault();
  try {
    await api("PUT", "/api/konto", { name: e.target.name.value });
    S.user.name = e.target.name.value.trim();
    angemeldet();
    toast("Gespeichert");
  } catch (err) { toast(err.message, true); }
});
$("#formPasswort").addEventListener("submit", async (e) => {
  e.preventDefault();
  const f = e.target;
  try {
    if (f.neu.value !== f.neu2.value) throw new Error("Neue Passwörter stimmen nicht überein");
    await api("POST", "/api/konto/passwort", { alt: f.alt.value, neu: f.neu.value });
    f.reset();
    toast("Passwort geändert");
  } catch (err) { toast(err.message, true); }
});

start().catch((err) => toast(err.message, true));
