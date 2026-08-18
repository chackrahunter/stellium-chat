#!/usr/bin/env node
/**
 * Statuskonsole des Stellium-Servers.
 *
 *   stellium          fortlaufend, aktualisiert sich alle fünf Sekunden
 *   stellium einmal   einmal ausgeben und beenden
 *
 * Sie zeigt alles, was man wissen will, ohne irgendwo nachsehen zu müssen:
 * wie man sich verbindet, ob der Dienst läuft, wann das Zertifikat abläuft,
 * wie warm der Pi ist, wie viele Leute gerade da sind.
 */
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';

const EINMAL = process.argv.includes('einmal');
const PORT = 8787;
const DATEN = '/var/lib/stellium';

const F = {
  aus: '\x1b[0m', fett: '\x1b[1m', grau: '\x1b[90m',
  gruen: '\x1b[38;5;42m', rot: '\x1b[38;5;203m', gelb: '\x1b[38;5;221m',
  blau: '\x1b[38;5;111m', violett: '\x1b[38;5;141m',
};

/** Befehl ausführen und Ausgabe zurückgeben; Fehler werden zu null. */
function ruf(befehl, args) {
  try {
    return execFileSync(befehl, args, { encoding: 'utf8', timeout: 4000, stdio: ['ignore', 'pipe', 'ignore'] }).trim();
  } catch { return null; }
}

function dienstLaeuft(name) {
  return ruf('systemctl', ['is-active', name]) === 'active';
}

function groesse(bytes) {
  if (!bytes) return '—';
  const e = ['B', 'KB', 'MB', 'GB', 'TB'];
  let w = bytes, i = 0;
  while (w >= 1024 && i < e.length - 1) { w /= 1024; i += 1; }
  return `${w < 10 && i > 0 ? w.toFixed(1) : Math.round(w)} ${e[i]}`;
}

function dauer(sekunden) {
  const t = Math.floor(sekunden / 86400);
  const s = Math.floor((sekunden % 86400) / 3600);
  const m = Math.floor((sekunden % 3600) / 60);
  if (t) return `${t} Tage, ${s} Std`;
  if (s) return `${s} Std, ${m} Min`;
  return `${m} Min`;
}

/** Adressen, unter denen der Server erreichbar ist. */
function adressen() {
  const liste = [];

  // Aus der nginx-Konfiguration den Servernamen ziehen.
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

  // Und immer die Adresse im eigenen Netz.
  for (const [, adressenDerKarte] of Object.entries(os.networkInterfaces())) {
    for (const a of adressenDerKarte ?? []) {
      if (a.family === 'IPv4' && !a.internal) {
        liste.push({ art: 'lokal', url: `http://${a.address}` });
      }
    }
  }
  return liste;
}

/** Wie lange gilt das Zertifikat noch? */
function zertifikat() {
  const orte = ['/etc/letsencrypt/live'];
  for (const ort of orte) {
    let dateien = [];
    try {
      dateien = fs.readdirSync(ort, { withFileTypes: true })
        .flatMap((e) => (e.isDirectory()
          ? [`${ort}/${e.name}/fullchain.pem`]
          : e.name.endsWith('.crt') ? [`${ort}/${e.name}`] : []));
    } catch { continue; }

    for (const datei of dateien) {
      const ende = ruf('openssl', ['x509', '-enddate', '-noout', '-in', datei]);
      if (!ende) continue;
      const tage = Math.round((new Date(ende.split('=')[1]) - Date.now()) / 86400000);
      return { tage, datei };
    }
  }
  return null;
}

/** Zustand vom Server selbst erfragen. */
async function serverZustand() {
  try {
    const r = await fetch(`http://127.0.0.1:${PORT}/api/health`, { signal: AbortSignal.timeout(2500) });
    if (!r.ok) return null;
    return await r.json();
  } catch { return null; }
}

function temperatur() {
  try {
    const roh = Number(fs.readFileSync('/sys/class/thermal/thermal_zone0/temp', 'utf8'));
    return Math.round(roh / 1000);
  } catch { return null; }
}

function datenbank() {
  try {
    const s = fs.statSync(`${DATEN}/stellium.db`);
    return { groesse: s.size, geaendert: s.mtimeMs };
  } catch { return null; }
}

function sicherungen() {
  try {
    const liste = fs.readdirSync(`${DATEN}/sicherungen`).filter((n) => n.endsWith('.gz'));
    if (!liste.length) return null;
    const neueste = liste
      .map((n) => ({ n, t: fs.statSync(`${DATEN}/sicherungen/${n}`).mtimeMs }))
      .sort((a, b) => b.t - a.t)[0];
    return { anzahl: liste.length, alter: Date.now() - neueste.t };
  } catch { return null; }
}

function speicher() {
  const aus = ruf('df', ['-B1', '--output=used,size', '/']);
  if (!aus) return null;
  const [belegt, gesamt] = aus.split('\n')[1].trim().split(/\s+/).map(Number);
  return { belegt, gesamt };
}

/** Balken für Auslastungen — auf einen Blick lesbar. */
function balken(anteil, breite = 22) {
  const voll = Math.round(Math.min(1, Math.max(0, anteil)) * breite);
  const farbe = anteil > 0.9 ? F.rot : anteil > 0.75 ? F.gelb : F.gruen;
  return `${farbe}${'█'.repeat(voll)}${F.grau}${'░'.repeat(breite - voll)}${F.aus}`;
}

function zeile(beschriftung, wert, farbe = '') {
  return `  ${F.grau}${beschriftung.padEnd(15)}${F.aus}${farbe}${wert}${F.aus}`;
}

async function zeichnen() {
  const [gesundheit] = await Promise.all([serverZustand()]);
  const dienst = dienstLaeuft('stellium');
  const web = dienstLaeuft('nginx');
  const zert = zertifikat();
  const db = datenbank();
  const sich = sicherungen();
  const platz = speicher();
  const temp = temperatur();
  const last = os.loadavg()[0] / os.cpus().length;
  const ramAnteil = 1 - os.freemem() / os.totalmem();

  const z = [];
  z.push('');
  z.push(`  ${F.violett}${F.fett}✦  Stellium${F.aus}   ${F.grau}${new Date().toLocaleString('de-DE')}${F.aus}`);
  z.push('');

  /* Verbinden */
  z.push(`  ${F.fett}Verbinden${F.aus}`);
  const adr = adressen();
  const sicher = adr.filter((a) => a.art === 'sicher');
  const lokal = adr.filter((a) => a.art === 'lokal');
  const offen = adr.filter((a) => a.art === 'offen');

  if (sicher.length) {
    for (const a of sicher) z.push(`    ${F.gruen}🔒${F.aus} ${F.fett}${F.blau}${a.url}${F.aus}`);
  }
  for (const a of offen) z.push(`    ${F.gelb}⚠${F.aus}  ${a.url} ${F.grau}(unverschlüsselt)${F.aus}`);
  for (const a of lokal.slice(0, 2)) z.push(`    ${F.grau}·  ${a.url}   nur im eigenen Netz${F.aus}`);
  if (!adr.length) z.push(`    ${F.rot}keine Adresse gefunden${F.aus}`);
  z.push('');
  z.push(`  ${F.grau}In der App unter Einstellungen → Server eintragen.${F.aus}`);
  z.push('');

  /* Zustand */
  z.push(`  ${F.fett}Zustand${F.aus}`);
  z.push(zeile('Chat-Dienst', dienst ? 'läuft' : 'AUS', dienst ? F.gruen : F.rot));
  z.push(zeile('Webserver', web ? 'läuft' : 'AUS', web ? F.gruen : F.rot));

  if (zert) {
    const farbe = zert.tage < 10 ? F.rot : zert.tage < 25 ? F.gelb : F.gruen;
    z.push(zeile('Zertifikat', `noch ${zert.tage} Tage gültig`, farbe));
  } else if (sicher.length) {
    z.push(zeile('Zertifikat', 'vorhanden', F.gruen));
  } else {
    z.push(zeile('Zertifikat', 'keines — Verbindung offen', F.gelb));
  }

  if (gesundheit?.ai) {
    const a = gesundheit.ai;
    const an = a.provider && a.provider !== 'demo';
    z.push(zeile('Übersetzung', an ? `an · ${a.model ?? a.provider}` : 'aus (kein Schlüssel)', an ? F.gruen : F.gelb));
  } else if (dienst) {
    z.push(zeile('Übersetzung', 'Server antwortet noch nicht', F.gelb));
  }
  z.push('');

  /* Pi */
  z.push(`  ${F.fett}Dieser Rechner${F.aus}`);
  z.push(`  ${F.grau}${'Last'.padEnd(15)}${F.aus}${balken(last)} ${F.grau}${(last * 100).toFixed(0)} %${F.aus}`);
  z.push(`  ${F.grau}${'Arbeitsspeicher'.padEnd(15)}${F.aus}${balken(ramAnteil)} ${F.grau}${groesse(os.totalmem() - os.freemem())} von ${groesse(os.totalmem())}${F.aus}`);
  if (platz) {
    z.push(`  ${F.grau}${'Speicherplatz'.padEnd(15)}${F.aus}${balken(platz.belegt / platz.gesamt)} ${F.grau}${groesse(platz.gesamt - platz.belegt)} frei${F.aus}`);
  }
  if (temp !== null) {
    const farbe = temp > 78 ? F.rot : temp > 65 ? F.gelb : F.gruen;
    z.push(zeile('Temperatur', `${temp} °C`, farbe));
  }
  z.push(zeile('Läuft seit', dauer(os.uptime())));
  z.push('');

  /* Daten */
  z.push(`  ${F.fett}Daten${F.aus}`);
  z.push(zeile('Datenbank', db ? groesse(db.groesse) : 'noch keine'));
  if (sich) {
    const stunden = Math.round(sich.alter / 3600000);
    const farbe = stunden > 30 ? F.gelb : F.gruen;
    z.push(zeile('Sicherung', `${sich.anzahl} Stände, letzte vor ${stunden} Std`, farbe));
  } else {
    z.push(zeile('Sicherung', 'noch keine — kommt heute Nacht', F.grau));
  }
  z.push('');

  if (!dienst) {
    z.push(`  ${F.rot}${F.fett}Der Chat-Dienst läuft nicht.${F.aus}`);
    z.push(`  ${F.grau}Nachsehen mit:  sudo journalctl -u stellium -n 50${F.aus}`);
    z.push(`  ${F.grau}Starten mit:    sudo systemctl start stellium${F.aus}`);
    z.push('');
  }

  z.push(`  ${F.grau}stellium einmal · sudo systemctl restart stellium · sudo journalctl -u stellium -f${F.aus}`);
  if (!EINMAL) z.push(`  ${F.grau}Beenden mit Strg+C${F.aus}`);
  z.push('');

  return z.join('\n');
}

if (EINMAL) {
  process.stdout.write(await zeichnen());
} else {
  // Alternativpuffer: beim Beenden ist das Terminal wieder, wie es war.
  process.stdout.write('\x1b[?1049h\x1b[?25l');
  const aufraeumen = () => { process.stdout.write('\x1b[?25h\x1b[?1049l'); process.exit(0); };
  process.on('SIGINT', aufraeumen);
  process.on('SIGTERM', aufraeumen);

  for (;;) {
    const bild = await zeichnen();
    process.stdout.write(`\x1b[H\x1b[2J${bild}`);
    await new Promise((r) => setTimeout(r, 5000));
  }
}
