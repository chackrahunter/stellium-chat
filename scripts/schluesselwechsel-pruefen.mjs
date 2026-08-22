#!/usr/bin/env node
/**
 * Schlägt ein falsches Masterpasswort laut fehl?
 *
 * Der Befund dahinter: `blindIndex()` ist ein deterministischer HMAC über den
 * Benutzernamen. In der laufenden Datenbank standen trotzdem zwei Konten
 * namens `stelliumai` mit verschiedenen `handle_bidx` — sie sind unter zwei
 * verschiedenen Schlüsseln entstanden. Derselbe Blind-Index trägt die
 * Anmeldung (services/users.ts). Ein Konto unter einem alten Schlüssel ist
 * mit dem aktuellen nicht mehr auffindbar, und nichts sagte, warum.
 *
 * Geprüft wird gegen WEGWERFBARE Datenbanken in einem eigenen Ordner — nie
 * gegen die echte. Muster wie scripts/umfrage-anonym-pruefen.mjs.
 *
 *   node scripts/schluesselwechsel-pruefen.mjs
 */
import { spawnSync } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const wurzel = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const serverOrdner = path.join(wurzel, 'packages/server');
const F = { aus: '\x1b[0m', gruen: '\x1b[38;5;42m', rot: '\x1b[38;5;203m', grau: '\x1b[90m' };
const sag = (t = '') => process.stdout.write(`${t}\n`);

/* Bewusst ohne deutsche Wörter darin: die Prüfung „steht das Passwort in der
   Ausgabe?" sucht auch nach Teilstücken, und ein Passwort, das mit „Passwort"
   anfängt, träfe auf die Meldung selbst zu. */
const A = 'Zt7Xk2QvAlpha4nR8s';
const B = 'Bm9Qm4ZwBeta6pL3tu';

let fehler = 0;
function pruef(name, ok, hinweis = '') {
  if (!ok) fehler++;
  sag(`  ${ok ? `${F.gruen}✓${F.aus}` : `${F.rot}✗${F.aus}`} ${name}${ok || !hinweis ? '' : `${F.grau}  ${hinweis}${F.aus}`}`);
}

const arbeit = fs.mkdtempSync(path.join(os.tmpdir(), 'stellium-schluessel-'));

/* Auf einem Mac holt sich der Server das Masterpasswort notfalls aus dem
   Schlüsselbund. Für den Fall „gar kein Passwort" muss auch dieser Weg zu
   sein — sonst prüfte der Lauf auf Dons Rechner etwas anderes als auf dem
   Server. Ein vorgeschobenes `security`, das nichts findet, erledigt das,
   ohne dass Testcode in den Server wandert. */
const schattenBin = path.join(arbeit, 'bin');
fs.mkdirSync(schattenBin);
fs.writeFileSync(path.join(schattenBin, 'security'), '#!/bin/sh\nexit 1\n', { mode: 0o755 });

/** Ein Start gegen den Ordner `daten` mit dem Passwort `passwort` (null = keines). */
function start(daten, passwort, { anlegen = false, wechselErlaubt = false } = {}) {
  const env = { ...process.env, DATA_DIR: daten };
  delete env.STELLIUM_SCHLUESSELWECHSEL;
  if (passwort === null) {
    delete env.STELLIUM_MASTER_PASSPHRASE;
    env.PATH = `${schattenBin}:${env.PATH ?? ''}`;
  } else {
    env.STELLIUM_MASTER_PASSPHRASE = passwort;
  }
  if (wechselErlaubt) env.STELLIUM_SCHLUESSELWECHSEL = 'ja';

  const args = ['tsx', 'src/pruefungen/schluessel-start.mts'];
  if (anlegen) args.push('--anlegen');
  const lauf = spawnSync('npx', args, { cwd: serverOrdner, env, encoding: 'utf8' });
  return {
    code: lauf.status,
    text: `${lauf.stdout ?? ''}${lauf.stderr ?? ''}`,
    gestartet: (lauf.stdout ?? '').includes('START-OK'),
  };
}

function ordnerAnlegen(name) {
  const p = path.join(arbeit, name);
  fs.mkdirSync(p, { recursive: true });
  return p;
}

function einstellung(daten, schluessel) {
  const db = new DatabaseSync(path.join(daten, 'stellium.db'));
  try {
    return db.prepare('SELECT value FROM app_settings WHERE key = ?').get(schluessel)?.value ?? null;
  } finally {
    db.close();
  }
}

function zeileLoeschen(daten, schluessel) {
  const db = new DatabaseSync(path.join(daten, 'stellium.db'));
  try {
    db.prepare('DELETE FROM app_settings WHERE key = ?').run(schluessel);
  } finally {
    db.close();
  }
}

try {
  /* ── Derselbe Schlüssel: nichts ändert sich ───────────────────── */
  sag(`\n${F.grau}Derselbe Schlüssel — die Gegenprobe${F.aus}`);
  const wechsel = ordnerAnlegen('wechsel');

  const erst = start(wechsel, A, { anlegen: true });
  pruef('erster Start mit Passwort A kommt hoch', erst.gestartet && erst.code === 0, erst.text.slice(-400));

  const probeA = einstellung(wechsel, 'schluessel_probe');
  pruef('eine Probe ist abgelegt', Boolean(probeA));
  pruef('sie ist verschlüsselt (v1:), nicht lesbar', Boolean(probeA?.startsWith('v1:')), String(probeA).slice(0, 12));

  const zweit = start(wechsel, A);
  pruef('zweiter Start mit demselben Passwort läuft unverändert durch', zweit.gestartet && zweit.code === 0, zweit.text.slice(-400));
  pruef('und sagt dabei nichts über den Schlüssel', !zweit.text.includes('[schluessel]'), zweit.text.slice(-200));
  pruef('die Probe bleibt unangetastet', einstellung(wechsel, 'schluessel_probe') === probeA);

  /* ── Anderer Schlüssel: laut scheitern ────────────────────────── */
  sag(`\n${F.grau}Anderer Schlüssel — es muss laut scheitern${F.aus}`);
  const falsch = start(wechsel, B);
  pruef('Start mit Passwort B bricht ab', falsch.code !== 0 && !falsch.gestartet, `Code ${falsch.code}`);
  pruef('Abbruchcode ist 1', falsch.code === 1, `Code ${falsch.code}`);
  pruef('Meldung sagt in einem Satz, was los ist',
    falsch.text.includes('Stellium startet nicht: das Masterpasswort passt nicht zu den Daten'));
  pruef('Meldung sagt, was zu tun ist', falsch.text.includes('STELLIUM_MASTER_PASSPHRASE'));
  pruef('keine Stapelspur', !/\n\s+at\s+\S+/.test(falsch.text), falsch.text.match(/\n\s+at\s+\S+.*/)?.[0] ?? '');
  pruef('kein Passwort in der Ausgabe — weder ganz …', !falsch.text.includes(A) && !falsch.text.includes(B));
  pruef('… noch gekürzt', !falsch.text.includes(A.slice(0, 8)) && !falsch.text.includes(B.slice(0, 8)));
  pruef('auch die Probe steht nicht in der Ausgabe', !falsch.text.includes(String(probeA).slice(4, 20)));
  pruef('die Datenbank bleibt unverändert: Probe noch die von A',
    einstellung(wechsel, 'schluessel_probe') === probeA);

  const ohne = start(wechsel, null);
  pruef('Start ganz ohne Masterpasswort bricht ebenso ab', ohne.code === 1 && !ohne.gestartet, `Code ${ohne.code}`);
  pruef('… und benennt genau diesen Fall',
    ohne.text.includes('es ist kein Masterpasswort gesetzt'), ohne.text.slice(-400));

  /* ── Der Übersetzungsspeicher überlebt den Fehlversuch ────────── */
  sag(`\n${F.grau}Was der Abbruch verhindert${F.aus}`);
  pruef('tm_format steht noch auf dem Wert von A — migrate() kam nicht dran, '
    + 'der Übersetzungsspeicher wurde nicht geleert',
    einstellung(wechsel, 'tm_format') !== null && !falsch.text.includes('Übersetzungsspeicher'));

  /* ── Der bewusste Wechsel kommt vorbei ────────────────────────── */
  sag(`\n${F.grau}Ausdrücklich gewollter Wechsel${F.aus}`);
  const erlaubt = start(wechsel, B, { wechselErlaubt: true });
  pruef('mit STELLIUM_SCHLUESSELWECHSEL=ja startet es', erlaubt.gestartet && erlaubt.code === 0, erlaubt.text.slice(-400));
  pruef('… aber es sagt laut, was das bedeutet',
    erlaubt.text.includes('[schluessel]') && erlaubt.text.includes('bleiben unlesbar'), erlaubt.text.slice(-300));
  const probeB = einstellung(wechsel, 'schluessel_probe');
  pruef('die Probe steht jetzt auf B', Boolean(probeB) && probeB !== probeA);

  const zurueck = start(wechsel, A);
  pruef('der Riegel hält auch rückwärts: A ist jetzt das falsche Passwort',
    zurueck.code === 1 && !zurueck.gestartet, `Code ${zurueck.code}`);

  /* ── Der vorgesehene Weg bleibt offen ─────────────────────────── */
  sag(`\n${F.grau}Erst ohne Masterpasswort, dann eines gesetzt — das muss gehen${F.aus}`);
  const nachruesten = ordnerAnlegen('nachruesten');
  const rohStart = start(nachruesten, null, { anlegen: true });
  pruef('Start ohne Masterpasswort kommt hoch', rohStart.gestartet && rohStart.code === 0, rohStart.text.slice(-400));
  const jetztMitSchluessel = start(nachruesten, A);
  pruef('danach mit Masterpasswort ebenfalls — es hängt ja nichts am alten Schlüssel',
    jetztMitSchluessel.gestartet && jetztMitSchluessel.code === 0, jetztMitSchluessel.text.slice(-400));
  pruef('… und es wird gesagt, dass nichts verloren geht',
    jetztMitSchluessel.text.includes('nichts geht verloren'), jetztMitSchluessel.text.slice(-300));

  /* ── Alte Datenbanken ohne Probe ──────────────────────────────── */
  sag(`\n${F.grau}Datenbank ohne Probe — die vorhandenen Kennungen tragen den ersten Start${F.aus}`);
  const altbestand = ordnerAnlegen('altbestand');
  const altErst = start(altbestand, A, { anlegen: true });
  pruef('Vorlauf mit Passwort A', altErst.gestartet && altErst.code === 0);
  const probeAlt = einstellung(altbestand, 'schluessel_probe');
  zeileLoeschen(altbestand, 'schluessel_probe');
  pruef('Probe entfernt — so sieht ein Server aus, der die Änderung noch nie gesehen hat',
    einstellung(altbestand, 'schluessel_probe') === null);
  pruef('fts_format und tm_format stehen dort aber längst',
    Boolean(einstellung(altbestand, 'fts_format')) && Boolean(einstellung(altbestand, 'tm_format')));
  const altFalsch = start(altbestand, B);
  pruef('Passwort B bricht trotzdem sofort ab, nicht erst beim übernächsten Start',
    altFalsch.code === 1 && !altFalsch.gestartet, altFalsch.text.slice(-400));

  /* ── Der Prüfwert verrät nichts ───────────────────────────────── */
  sag(`\n${F.grau}Verrät die Probe etwas?${F.aus}`);
  pruef('kein Passwort im abgelegten Wert', !probeA.includes(A) && !probeA.includes(A.slice(0, 8)));
  pruef('kein Klartext im abgelegten Wert', !probeA.includes('stellium/schluesselprobe'));
  pruef('zwei Datenbanken mit DEMSELBEN Passwort legen VERSCHIEDENE Werte ab — '
    + 'man kann nicht einmal erkennen, ob zwei Server dasselbe Passwort haben',
    probeA !== probeAlt, `${String(probeA).slice(0, 10)} / ${String(probeAlt).slice(0, 10)}`);
  const altKennung = einstellung(altbestand, 'fts_format');
  const wechselKennung = einstellung(wechsel, 'tm_format');
  pruef('zum Vergleich: die alte Kennung fts_format ist über Installationen hinweg GLEICH, '
    + 'wenn das Passwort gleich ist', altKennung === einstellung(nachruesten, 'fts_format'),
    `${altKennung} / ${einstellung(nachruesten, 'fts_format')}`);
  void wechselKennung;
} finally {
  fs.rmSync(arbeit, { recursive: true, force: true });
}

sag(fehler
  ? `\n${F.rot}${fehler} fehlgeschlagen${F.aus}\n`
  : `\n${F.gruen}Ein falsches Masterpasswort scheitert laut — der Server startet gar nicht erst.${F.aus}\n`);
process.exit(fehler ? 1 : 0);
