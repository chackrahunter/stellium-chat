#!/usr/bin/env node
/**
 * Statuskonsole des Stellium-Servers.
 *
 *   stellium          fortlaufend, aktualisiert sich alle drei Sekunden
 *   stellium einmal   einmal ausgeben und beenden
 *
 * Gezeigt wird nur, was dieser Rechner wirklich hat. Eine Zeile für eine
 * Grafikeinheit, die es nicht gibt, oder für einen Lüfter, der nicht verbaut
 * ist, wäre nur Rauschen — deshalb fällt sie ganz weg statt "n/a" zu sagen.
 */
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';

const EINMAL = process.argv.includes('einmal');
const PORT = Number(process.env.STELLIUM_PORT ?? 8787);
const DATEN = process.env.STELLIUM_DATA ?? '/var/lib/stellium';
const ZIEL = '/opt/stellium';

const F = {
  aus: '\x1b[0m', fett: '\x1b[1m', grau: '\x1b[90m',
  gruen: '\x1b[38;5;42m', rot: '\x1b[38;5;203m', gelb: '\x1b[38;5;221m',
  blau: '\x1b[38;5;111m', violett: '\x1b[38;5;141m', tuerkis: '\x1b[38;5;80m',
};

const BREITE = Math.max(64, Math.min(process.stdout.columns || 92, 110));

function ruf(befehl, args, zeit = 3500) {
  try {
    return execFileSync(befehl, args, { encoding: 'utf8', timeout: zeit, stdio: ['ignore', 'pipe', 'ignore'] }).trim();
  } catch { return null; }
}

const dienstAktiv = (name) => ruf('systemctl', ['is-active', name]) === 'active';
const dienstAn = (name) => ruf('systemctl', ['is-enabled', name]) === 'enabled';

function groesse(bytes) {
  if (bytes === null || bytes === undefined) return '—';
  const e = ['B', 'KB', 'MB', 'GB', 'TB'];
  let w = bytes, i = 0;
  while (w >= 1024 && i < e.length - 1) { w /= 1024; i += 1; }
  return `${w < 10 && i > 0 ? w.toFixed(1) : Math.round(w)} ${e[i]}`;
}

function dauer(sek) {
  const t = Math.floor(sek / 86400);
  const s = Math.floor((sek % 86400) / 3600);
  const m = Math.floor((sek % 3600) / 60);
  if (t) return `${t} ${t === 1 ? 'Tag' : 'Tage'}, ${s} Std`;
  if (s) return `${s} Std, ${m} Min`;
  return `${m} Min`;
}

/* ── Was der Rechner hergibt ─────────────────────────────────── */

/** Auslastung der Prozessorkerne über einen kurzen Zeitraum. */
let letzteCpu = null;
function cpuAuslastung() {
  const jetzt = os.cpus().reduce((a, c) => {
    const gesamt = Object.values(c.times).reduce((x, y) => x + y, 0);
    return { gesamt: a.gesamt + gesamt, leerlauf: a.leerlauf + c.times.idle };
  }, { gesamt: 0, leerlauf: 0 });

  if (!letzteCpu) { letzteCpu = jetzt; return os.loadavg()[0] / os.cpus().length; }
  const dg = jetzt.gesamt - letzteCpu.gesamt;
  const dl = jetzt.leerlauf - letzteCpu.leerlauf;
  letzteCpu = jetzt;
  return dg > 0 ? Math.min(1, Math.max(0, 1 - dl / dg)) : 0;
}

/** Temperaturen — jede gefundene Zone mit brauchbarem Namen. */
function temperaturen() {
  const werte = [];
  try {
    for (const eintrag of fs.readdirSync('/sys/class/thermal')) {
      if (!eintrag.startsWith('thermal_zone')) continue;
      const roh = Number(fs.readFileSync(`/sys/class/thermal/${eintrag}/temp`, 'utf8'));
      if (!Number.isFinite(roh) || roh <= 0) continue;
      let name = 'CPU';
      try { name = fs.readFileSync(`/sys/class/thermal/${eintrag}/type`, 'utf8').trim(); } catch { /* egal */ }
      werte.push({ name: name.replace(/_thermal|-thermal|_zone\d*/g, '') || 'CPU', grad: Math.round(roh / 1000) });
    }
  } catch { /* kein thermal-Verzeichnis */ }
  return werte;
}

/** Taktrate des Prozessors, falls ablesbar. */
function takt() {
  const vc = ruf('vcgencmd', ['measure_clock', 'arm']);
  if (vc) {
    const hz = Number(vc.split('=')[1]);
    if (Number.isFinite(hz) && hz > 0) return Math.round(hz / 1e6);
  }
  try {
    const khz = Number(fs.readFileSync('/sys/devices/system/cpu/cpu0/cpufreq/scaling_cur_freq', 'utf8'));
    if (Number.isFinite(khz) && khz > 0) return Math.round(khz / 1000);
  } catch { /* nicht vorhanden */ }
  return null;
}

/** Grafikeinheit: beim Pi über vcgencmd, sonst gar nicht. */
function grafik() {
  const speicher = ruf('vcgencmd', ['get_mem', 'gpu']);
  const frequenz = ruf('vcgencmd', ['measure_clock', 'core']);
  if (!speicher && !frequenz) return null;
  const mb = speicher ? Number(speicher.split('=')[1]?.replace('M', '')) : null;
  const mhz = frequenz ? Math.round(Number(frequenz.split('=')[1]) / 1e6) : null;
  return { mb, mhz };
}

/** Drosselt der Pi gerade? Das erklärt langsame Antworten. */
function drosselung() {
  const roh = ruf('vcgencmd', ['get_throttled']);
  if (!roh) return null;
  const wert = Number.parseInt(roh.split('=')[1], 16);
  if (!Number.isFinite(wert) || wert === 0) return { jetzt: [], frueher: [] };
  const jetzt = [];
  const frueher = [];
  if (wert & 0x1) jetzt.push('Unterspannung');
  if (wert & 0x2) jetzt.push('Takt begrenzt');
  if (wert & 0x4) jetzt.push('gedrosselt');
  if (wert & 0x8) jetzt.push('Temperaturgrenze');
  if (wert & 0x10000) frueher.push('Unterspannung');
  if (wert & 0x40000) frueher.push('gedrosselt');
  return { jetzt, frueher };
}

function platte(pfad = '/') {
  const aus = ruf('df', ['-B1', '--output=used,size,target', pfad]);
  if (!aus) return null;
  const zeile = aus.split('\n')[1]?.trim().split(/\s+/);
  if (!zeile) return null;
  return { belegt: Number(zeile[0]), gesamt: Number(zeile[1]) };
}

/** Auslagerungsspeicher, falls eingerichtet. */
function swap() {
  try {
    const text = fs.readFileSync('/proc/meminfo', 'utf8');
    const gesamt = Number(/SwapTotal:\s+(\d+)/.exec(text)?.[1] ?? 0) * 1024;
    const frei = Number(/SwapFree:\s+(\d+)/.exec(text)?.[1] ?? 0) * 1024;
    if (!gesamt) return null;
    return { belegt: gesamt - frei, gesamt };
  } catch { return null; }
}

/** Netzverkehr seit dem Start, über alle echten Karten. */
function netz() {
  try {
    let rein = 0, raus = 0;
    for (const karte of fs.readdirSync('/sys/class/net')) {
      if (karte === 'lo') continue;
      rein += Number(fs.readFileSync(`/sys/class/net/${karte}/statistics/rx_bytes`, 'utf8'));
      raus += Number(fs.readFileSync(`/sys/class/net/${karte}/statistics/tx_bytes`, 'utf8'));
    }
    return { rein, raus };
  } catch { return null; }
}

function modell() {
  try { return fs.readFileSync('/proc/device-tree/model', 'utf8').replace(/\0/g, '').trim(); }
  catch { return `${os.type()} ${os.arch()}`; }
}

/* ── Was Stellium hergibt ────────────────────────────────────── */

async function gesundheit() {
  try {
    const r = await fetch(`http://127.0.0.1:${PORT}/api/health`, { signal: AbortSignal.timeout(2500) });
    return r.ok ? await r.json() : null;
  } catch { return null; }
}

function zahlen() {
  const datei = `${DATEN}/stellium.db`;
  if (!fs.existsSync(datei)) return null;
  const felder = ['users', 'channels', 'messages', 'tasks', 'events', 'files', 'ideas'];
  const ergebnis = {};
  for (const t of felder) {
    const aus = ruf('sqlite3', ['-readonly', datei, `SELECT COUNT(*) FROM ${t};`]);
    if (aus !== null && aus !== '') ergebnis[t] = Number(aus);
  }
  try { ergebnis.groesse = fs.statSync(datei).size; } catch { /* egal */ }
  return Object.keys(ergebnis).length ? ergebnis : null;
}

function version() {
  try { return JSON.parse(fs.readFileSync(`${ZIEL}/packages/desktop/package.json`, 'utf8')).version; }
  catch { return null; }
}

function adressen() {
  const liste = [];
  try {
    const conf = fs.readFileSync('/etc/nginx/sites-available/stellium', 'utf8');
    const tls = /listen\s+443/.test(conf);
    const namen = [...conf.matchAll(/server_name\s+([^;]+);/g)]
      .flatMap((m) => m[1].trim().split(/\s+/))
      .filter((n) => n !== '_' && n !== 'localhost');
    for (const n of [...new Set(namen)]) {
      liste.push({ art: tls ? 'sicher' : 'offen', url: `${tls ? 'https' : 'http'}://${n}` });
    }
  } catch { /* nginx noch nicht eingerichtet */ }

  for (const [, karten] of Object.entries(os.networkInterfaces())) {
    for (const a of karten ?? []) {
      if (a.family === 'IPv4' && !a.internal) liste.push({ art: 'lokal', url: `http://${a.address}` });
    }
  }
  return liste;
}

function zertifikat() {
  try {
    for (const name of fs.readdirSync('/etc/letsencrypt/live', { withFileTypes: true })) {
      if (!name.isDirectory()) continue;
      const ende = ruf('openssl', ['x509', '-enddate', '-noout', '-in', `/etc/letsencrypt/live/${name.name}/fullchain.pem`]);
      if (!ende) continue;
      return {
        name: name.name,
        tage: Math.round((new Date(ende.split('=')[1]) - Date.now()) / 86400000),
      };
    }
  } catch { /* keines vorhanden */ }
  return null;
}

/** Fassung der beteiligten Programme — nur die, die es gibt. */
function bestandteile() {
  const liste = [];
  const nimm = (name, befehl, args, muster) => {
    const aus = ruf(befehl, args);
    if (!aus) return;
    const treffer = muster.exec(aus);
    liste.push({ name, fassung: treffer ? treffer[1] : aus.split('\n')[0].slice(0, 24) });
  };
  liste.push({ name: 'Node', fassung: process.versions.node });
  nimm('nginx', 'nginx', ['-v'], /nginx\/([\d.]+)/);
  nimm('certbot', 'certbot', ['--version'], /certbot ([\d.]+)/);
  nimm('SQLite', 'sqlite3', ['--version'], /^([\d.]+)/);
  nimm('fail2ban', 'fail2ban-server', ['--version'], /v([\d.]+)/);
  nimm('ufw', 'ufw', ['version'], /ufw ([\d.]+)/);
  return liste;
}

/** Wie viele Sperren hat fail2ban gerade? */
function gesperrt() {
  const aus = ruf('fail2ban-client', ['status', 'sshd']);
  if (!aus) return null;
  const n = /Currently banned:\s+(\d+)/.exec(aus);
  return n ? Number(n[1]) : null;
}

/* ── Darstellung ─────────────────────────────────────────────── */

function balken(anteil, breite = 20) {
  const a = Math.min(1, Math.max(0, anteil || 0));
  const voll = Math.round(a * breite);
  const farbe = a > 0.9 ? F.rot : a > 0.75 ? F.gelb : F.gruen;
  return `${farbe}${'█'.repeat(voll)}${F.grau}${'░'.repeat(breite - voll)}${F.aus}`;
}

const z = [];
const schreib = (t = '') => z.push(t);
const feld = (name, wert, farbe = '') => schreib(`  ${F.grau}${name.padEnd(16)}${F.aus}${farbe}${wert}${F.aus}`);
const messwert = (name, anteil, rechts) =>
  schreib(`  ${F.grau}${name.padEnd(16)}${F.aus}${balken(anteil)} ${F.grau}${rechts}${F.aus}`);

function ueberschrift(text, farbe = F.violett) {
  schreib();
  schreib(`  ${farbe}${F.fett}${text}${F.aus}  ${F.grau}${'─'.repeat(Math.max(0, BREITE - text.length - 6))}${F.aus}`);
}

async function zeichnen() {
  z.length = 0;
  const g = await gesundheit();
  const chat = dienstAktiv('stellium');
  const web = dienstAktiv('nginx');
  const zert = zertifikat();
  const db = zahlen();
  const v = version();

  schreib();
  schreib(`  ${F.violett}${F.fett}✦  Stellium${F.aus}${v ? `  ${F.grau}${v}${F.aus}` : ''}   ${F.grau}${modell()} · ${new Date().toLocaleString('de-DE')}${F.aus}`);

  /* ── Verbinden ───────────────────────────────────────────── */
  ueberschrift('Verbinden', F.blau);
  const adr = adressen();
  const sicher = adr.filter((a) => a.art === 'sicher');
  const offen = adr.filter((a) => a.art === 'offen');
  const lokal = adr.filter((a) => a.art === 'lokal');

  for (const a of sicher) schreib(`    ${F.gruen}🔒${F.aus}  ${F.fett}${F.blau}${a.url}${F.aus}`);
  for (const a of offen) schreib(`    ${F.gelb}⚠${F.aus}   ${a.url}  ${F.grau}unverschlüsselt${F.aus}`);
  for (const a of lokal.slice(0, 2)) schreib(`    ${F.grau}·   ${a.url}   im eigenen Netz${F.aus}`);
  if (!adr.length) schreib(`    ${F.rot}keine Adresse gefunden${F.aus}`);
  schreib(`    ${F.grau}In der App unter Einstellungen → Server eintragen.${F.aus}`);

  /* ── Chat ────────────────────────────────────────────────── */
  ueberschrift('Chat-Server', F.tuerkis);
  feld('Dienst', chat ? (dienstAn('stellium') ? 'läuft · startet automatisch' : 'läuft · KEIN Autostart') : 'AUS',
    chat ? (dienstAn('stellium') ? F.gruen : F.gelb) : F.rot);

  if (g?.ai) {
    const an = g.ai.provider && g.ai.provider !== 'demo';
    feld('Übersetzung', an ? `an · ${g.ai.provider}` : 'aus — kein Schlüssel hinterlegt', an ? F.gruen : F.gelb);
    if (an && g.ai.model) feld('Modell', g.ai.model);
    if (an && g.ai.fastModel) feld('Schnellmodell', g.ai.fastModel);
    if (g.ai.modelsAvailable) feld('Modelle', `${g.ai.modelsAvailable} verfügbar${g.ai.modelSource === 'auto' ? ', automatisch gewählt' : ''}`);
    if (g.ai.transcription) feld('Sprachnachricht', 'Umschrift möglich', F.gruen);
  } else if (chat) {
    feld('Übersetzung', 'Server antwortet noch nicht', F.gelb);
  }

  if (db) {
    const teile = [];
    if (db.users !== undefined) teile.push(`${db.users} Konten`);
    if (db.channels !== undefined) teile.push(`${db.channels} Kanäle`);
    if (db.messages !== undefined) teile.push(`${db.messages} Nachrichten`);
    feld('Inhalt', teile.join(' · '));
    const weiter = [];
    if (db.tasks) weiter.push(`${db.tasks} Aufgaben`);
    if (db.events) weiter.push(`${db.events} Termine`);
    if (db.files) weiter.push(`${db.files} Dateien`);
    if (db.ideas) weiter.push(`${db.ideas} Ideen`);
    if (weiter.length) feld('', weiter.join(' · '));
    if (db.groesse) feld('Datenbank', groesse(db.groesse));
  }

  /* ── Weg nach außen ──────────────────────────────────────── */
  ueberschrift('Weg nach außen', F.blau);
  feld('nginx', web ? (dienstAn('nginx') ? 'läuft · startet automatisch' : 'läuft') : 'AUS', web ? F.gruen : F.rot);
  if (zert) {
    const farbe = zert.tage < 10 ? F.rot : zert.tage < 25 ? F.gelb : F.gruen;
    feld('Zertifikat', `${zert.name} · noch ${zert.tage} Tage`, farbe);
  } else if (sicher.length) {
    feld('Zertifikat', 'vorhanden', F.gruen);
  } else {
    feld('Zertifikat', 'keines — Verbindung offen', F.gelb);
  }
  const feuer = ruf('ufw', ['status']);
  if (feuer) feld('Firewall', /Status: active/.test(feuer) ? 'aktiv' : 'AUS', /Status: active/.test(feuer) ? F.gruen : F.rot);
  const sperren = gesperrt();
  if (sperren !== null) feld('fail2ban', sperren ? `${sperren} gesperrt` : 'wacht, nichts gesperrt', sperren ? F.gelb : F.gruen);

  /* ── Leistung ────────────────────────────────────────────── */
  ueberschrift('Leistung', F.violett);
  const kerne = os.cpus().length;
  const mhz = takt();
  messwert('Prozessor', cpuAuslastung(), `${kerne} Kerne${mhz ? ` · ${mhz} MHz` : ''}`);

  const ramAnteil = 1 - os.freemem() / os.totalmem();
  messwert('Arbeitsspeicher', ramAnteil, `${groesse(os.totalmem() - os.freemem())} von ${groesse(os.totalmem())}`);

  const sw = swap();
  if (sw) messwert('Auslagerung', sw.belegt / sw.gesamt, `${groesse(sw.belegt)} von ${groesse(sw.gesamt)}`);

  const pl = platte('/');
  if (pl) messwert('Speicherplatz', pl.belegt / pl.gesamt, `${groesse(pl.gesamt - pl.belegt)} frei`);

  const gpu = grafik();
  if (gpu) {
    const rechts = [gpu.mb ? `${gpu.mb} MB` : null, gpu.mhz ? `${gpu.mhz} MHz` : null].filter(Boolean).join(' · ');
    if (rechts) feld('Grafik', rechts);
  }

  for (const t of temperaturen()) {
    const farbe = t.grad > 78 ? F.rot : t.grad > 65 ? F.gelb : F.gruen;
    feld(t.name.length > 14 ? 'Temperatur' : t.name, `${t.grad} °C`, farbe);
  }

  const dr = drosselung();
  if (dr && (dr.jetzt.length || dr.frueher.length)) {
    if (dr.jetzt.length) feld('Achtung', dr.jetzt.join(', '), F.rot);
    else feld('Früher mal', dr.frueher.join(', '), F.gelb);
  }

  const n = netz();
  if (n) feld('Netz', `${groesse(n.rein)} empfangen · ${groesse(n.raus)} gesendet`);
  feld('Läuft seit', dauer(os.uptime()));

  /* ── Bestandteile ────────────────────────────────────────── */
  const teile = bestandteile();
  if (teile.length) {
    ueberschrift('Bestandteile', F.grau);
    schreib(`  ${teile.map((t) => `${F.grau}${t.name}${F.aus} ${t.fassung}`).join(`${F.grau}  ·  ${F.aus}`)}`);
  }

  /* ── Sicherung ───────────────────────────────────────────── */
  let sicherung = null;
  try {
    const liste = fs.readdirSync(`${DATEN}/sicherungen`).filter((x) => x.endsWith('.gz'));
    if (liste.length) {
      const neueste = liste.map((x) => fs.statSync(`${DATEN}/sicherungen/${x}`).mtimeMs).sort((a, b) => b - a)[0];
      sicherung = { anzahl: liste.length, stunden: Math.round((Date.now() - neueste) / 3600000) };
    }
  } catch { /* noch keine */ }

  ueberschrift('Sicherung', F.grau);
  if (sicherung) {
    feld('Stände', `${sicherung.anzahl} · letzter vor ${sicherung.stunden} Std`,
      sicherung.stunden > 30 ? F.gelb : F.gruen);
  } else {
    feld('Stände', 'noch keiner — der erste kommt heute Nacht um 3:30');
  }

  /* ── Hinweise ────────────────────────────────────────────── */
  if (!chat) {
    schreib();
    schreib(`  ${F.rot}${F.fett}Der Chat-Dienst läuft nicht.${F.aus}`);
    schreib(`  ${F.grau}sudo journalctl -u stellium -n 50   ·   sudo systemctl start stellium${F.aus}`);
  }

  schreib();
  schreib(`  ${F.grau}sudo systemctl restart stellium  ·  sudo journalctl -u stellium -f  ·  sudo stellium-sichern${F.aus}`);
  if (!EINMAL) schreib(`  ${F.grau}Beenden mit Strg+C${F.aus}`);
  schreib();

  return z.join('\n');
}

if (EINMAL) {
  process.stdout.write(await zeichnen());
} else {
  process.stdout.write('\x1b[?1049h\x1b[?25l');
  const aufraeumen = () => { process.stdout.write('\x1b[?25h\x1b[?1049l'); process.exit(0); };
  process.on('SIGINT', aufraeumen);
  process.on('SIGTERM', aufraeumen);
  for (;;) {
    process.stdout.write(`\x1b[H\x1b[2J${await zeichnen()}`);
    await new Promise((r) => setTimeout(r, 3000));
  }
}
