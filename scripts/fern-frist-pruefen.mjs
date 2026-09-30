#!/usr/bin/env node
/**
 * Leitungsmessungen verfallen — die Frist LEITUNG_FRIST_MS in
 * server-setup/fernsteuerung/dienst/fern-dienst.mjs.
 *
 * Der Dienst startet beim Laden sofort, deshalb werden hier nur die drei
 * Funktionen `leitungFrisch`, `stauMasse` und `rateWunschNachziehen` aus dem
 * Quelltext gelöst und mit Attrappen in einer eigenen Umgebung ausgeführt.
 * Geprüft wird: frische Messwerte zählen (Rohrfüllung, gemessener Durchsatz),
 * veraltete nicht mehr (Rohr 0, Zielrate, kein Hochziehen auf den alten
 * Messwert).
 *
 *     node scripts/fern-frist-pruefen.mjs
 */
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const wurzel = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const quelle = fs.readFileSync(path.join(wurzel, 'server-setup/fernsteuerung/dienst/fern-dienst.mjs'), 'utf8');

/* Eine Funktion samt Rumpf aus dem Quelltext lösen: ab `function name(` bis
   zur schließenden Klammer auf gleicher Tiefe. */
function funktion(name) {
  const start = quelle.indexOf(`function ${name}(`);
  if (start < 0) throw new Error(`${name} fehlt in fern-dienst.mjs`);
  let tiefe = 0;
  for (let i = quelle.indexOf('{', start); i < quelle.length; i += 1) {
    if (quelle[i] === '{') tiefe += 1;
    else if (quelle[i] === '}' && --tiefe === 0) return quelle.slice(start, i + 1);
  }
  throw new Error(`${name}: Ende nicht gefunden`);
}
/* Nur Zahlenausdrücke wie `64 * 1024` oder `6000` — alles andere ist ein Fehler. */
const konstante = (name) => {
  const ausdruck = new RegExp(`const ${name}\\s*=\\s*([^;\\n]+);`).exec(quelle)?.[1] ?? '';
  if (!/^[\d_.\s*+/()-]+$/.test(ausdruck)) throw new Error(`${name}: kein reiner Zahlenausdruck (${ausdruck})`);
  return vm.runInNewContext(ausdruck);
};

const umgebung = {
  LEITUNG_FRIST_MS: konstante('LEITUNG_FRIST_MS'),
  STAU_ZEIT_S: konstante('STAU_ZEIT_S'),
  STAU_MINDEST: konstante('STAU_MINDEST'),
  hostRate: 6000, hostMax: 8000, host: {},
  sendestau: (s) => s.stau ?? 0,
  waechstStau: () => false,
  leitungMessen: () => {},
  VERMITTELT_FRIST_MS: konstante('VERMITTELT_FRIST_MS'),
  PORT: 7788,
  execFile: () => { throw new Error('ss darf hier nicht laufen'); },
  rateAnHost: () => {},
  Date, Math,
};
vm.createContext(umgebung);
vm.runInContext([funktion('leitungFrisch'), funktion('stauMasse'), funktion('rateWunschNachziehen')].join('\n'), umgebung);
const { leitungFrisch, stauMasse, rateWunschNachziehen } = umgebung;
/* leitungMessen in einem eigenen Zusammenhang — im ersten ist es durch eine
   Attrappe ersetzt, damit rateWunschNachziehen kein `ss` startet. */
const umgebung2 = { ...umgebung };
vm.createContext(umgebung2);
vm.runInContext([funktion('vermittelt'), funktion('leitungMessen')].join('\n'), umgebung2);
const { leitungMessen: echtesLeitungMessen } = umgebung2;

let fehler = 0;
const pruefe = (was, ok, zusatz = '') => {
  if (!ok) fehler++;
  console.log(`  ${ok ? '\x1b[32m✓' : '\x1b[31m✗'}\x1b[0m ${was}${zusatz ? `  \x1b[90m${zusatz}\x1b[0m` : ''}`);
};

const jetzt = Date.now();
const frist = umgebung.LEITUNG_FRIST_MS;
/* 400 kbit/s bei 500 ms Laufzeit: Rohr 25 KB. Unterwegs 30 KB. */
const sitzung = (alter) => ({ stau: 30_000, laufzeitMs: 500, durchsatzKbit: 400, leitungStand: alter === null ? undefined : jetzt - alter });

console.log('\nFrist');
pruefe('frisch gleich nach der Messung', leitungFrisch(sitzung(0), jetzt));
pruefe('frisch genau an der Frist', leitungFrisch(sitzung(frist), jetzt));
pruefe('veraltet danach', !leitungFrisch(sitzung(frist + 1), jetzt));
pruefe('ohne Stand veraltet', !leitungFrisch(sitzung(null), jetzt));

console.log('\nstauMasse');
const f = stauMasse(sitzung(1000));
pruefe('frisch: Rohrfüllung abgezogen', f.stau === 5000, `stau ${f.stau}`);
pruefe('frisch: erlaubt aus gemessenem Durchsatz', f.erlaubt === Math.max(umgebung.STAU_MINDEST, 400 * 125 * umgebung.STAU_ZEIT_S), `erlaubt ${f.erlaubt}`);
const v = stauMasse(sitzung(frist + 5000));
pruefe('veraltet: kein Rohr, alles zählt als Stau', v.stau === 30_000, `stau ${v.stau}`);
pruefe('veraltet: erlaubt aus der Zielrate', v.erlaubt === Math.max(umgebung.STAU_MINDEST, 6000 * 125 * umgebung.STAU_ZEIT_S), `erlaubt ${v.erlaubt}`);

console.log('\nrateWunschNachziehen');
/* Kein Stau, Rate 1000, gemessen 7000: frisch geht es gleich auf 0,95 × 7000,
   veraltet nur um 8 %. */
const hoch = (alter) => {
  const s = { stau: 0, laufzeitMs: 50, durchsatzKbit: 7000, rateWunsch: 1000, leitungStand: jetzt - alter };
  rateWunschNachziehen(s);
  return s.rateWunsch;
};
pruefe('frisch: auf den gemessenen Durchsatz', hoch(1000) === 6650, `${hoch(1000)}`);
pruefe('veraltet: nur der kleine Schritt', hoch(frist + 5000) === 1080, `${hoch(frist + 5000)}`);

console.log('\nMeldungen des Vermittlers (Browser-Weg)');
{
  /* Ein alter Durchsatz von vor zehn Sekunden, dazu eine frische Meldung,
     die (noch) nichts gemessen hat. Die Meldung darf den alten Wert nicht
     frisch machen. */
  const alt = jetzt - frist - 4000;
  const s = { durchsatzKbit: 7000, laufzeitMs: 40, leitungStand: alt,
    vermittelt: { unterwegs: 0, laufzeitMs: null, durchsatzKbit: null, stand: Date.now() } };
  echtesLeitungMessen(s);
  pruefe('eine leere Meldung macht alte Werte nicht frisch', !leitungFrisch(s), `Stand vor ${Date.now() - s.leitungStand} ms`);
  const halb = { durchsatzKbit: 7000, laufzeitMs: 40, leitungStand: alt,
    vermittelt: { unterwegs: 0, laufzeitMs: 25, durchsatzKbit: null, stand: Date.now() } };
  echtesLeitungMessen(halb);
  pruefe('eine halbe Meldung auch nicht — und übernimmt nichts',
    !leitungFrisch(halb) && halb.laufzeitMs === 40 && halb.durchsatzKbit === 7000, JSON.stringify(halb));
  /* Über Loopback ist 0 ms eine echte Laufzeit, keine fehlende. */
  const loop = { leitungStand: alt,
    vermittelt: { unterwegs: 0, laufzeitMs: 0, durchsatzKbit: 3000, stand: Date.now() } };
  echtesLeitungMessen(loop);
  pruefe('Laufzeit 0 ms zählt als gemessen', leitungFrisch(loop) && loop.laufzeitMs === 0 && loop.durchsatzKbit === 3000);
  const t = { leitungStand: alt,
    vermittelt: { unterwegs: 0, laufzeitMs: 30, durchsatzKbit: 2500, stand: Date.now() } };
  echtesLeitungMessen(t);
  pruefe('eine Meldung mit Messwerten schon', leitungFrisch(t) && t.durchsatzKbit === 2500 && t.laufzeitMs === 30);
}

console.log(fehler ? `\n\x1b[31m${fehler} Prüfung(en) rot\x1b[0m` : '\n\x1b[32mAlles grün\x1b[0m');
process.exit(fehler ? 1 : 0);
