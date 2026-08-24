#!/usr/bin/env node
/**
 * Übersteht newId() (src/util/id.ts) eine Systemuhr, die beim Start hinter
 * der zuletzt vergebenen Kennung zurückliegt?
 *
 * Der Befund: der Pi hat keine batteriegepufferte Uhr. Bootet er nach einem
 * Stromausfall, läuft er mit dem letzten von systemd gespeicherten Uhrstand
 * los — meist ein Stück VOR dem tatsächlichen Absturzzeitpunkt — bis
 * systemd-timesyncd den nächsten NTP-Abgleich schafft. Eine in diesem
 * Fenster geschriebene Nachricht bekäme sonst eine Kennung mit zu alter
 * Zeit, sortierte unter die letzte Nachricht des vorigen Laufs und damit
 * unter jede schon gesetzte Lesemarke (services/store.ts:unreadCounts,
 * services/messages.ts:readReceiptsBatch) — lautlos „gelesen", für immer.
 *
 * Geprüft wird nicht an einer Nachbildung, sondern an der ECHTEN newId() aus
 * einem eigenen, kurzlebigen Prozess (src/pruefungen/kennung-mint.mts) — mit
 * gemockter Date.now() und, für den Neustart-Fall, einer wirklich
 * NEUGESTARTETEN node-Instanz gegen dieselbe WEGWERFBARE Datenbank. Ein
 * prozessinterner Merker allein bewiese nichts: der Neustart selbst ist der
 * gefährliche Moment. Dasselbe Muster wie scripts/schluesselwechsel-
 * pruefen.mjs mit src/pruefungen/schluessel-start.mts.
 *
 *   node scripts/kennung-wasserlinie-pruefen.mjs
 */
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const wurzel = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const serverOrdner = path.join(wurzel, 'packages/server');
const F = { aus: '\x1b[0m', gruen: '\x1b[38;5;42m', rot: '\x1b[38;5;203m', grau: '\x1b[90m' };
const sag = (t = '') => process.stdout.write(`${t}\n`);

let fehler = 0;
function pruef(name, ok, hinweis = '') {
  if (!ok) fehler++;
  sag(`  ${ok ? `${F.gruen}✓${F.aus}` : `${F.rot}✗${F.aus}`} ${name}${ok || !hinweis ? '' : `${F.grau}  ${hinweis}${F.aus}`}`);
}

/* Dasselbe Format wie util/id.ts: neun Basis-36-Stellen Zeit, drei
   Basis-36-Stellen Laufnummer, elf Zeichen Zufall — hier nachgebaut, um
   Kennungen aus der Prozessausgabe zu zerlegen und um eine glaubwürdige
   „Kennung aus einem vorigen Lauf" von Hand zu bauen, ohne dafür newId()
   selbst zu brauchen. */
const ZEIT_STELLEN = 9;
const LAUF_STELLEN = 3;
const ZUFALL_STELLEN = 11;

function zerlegen(prefix, id) {
  const rumpf = id.slice(prefix.length);
  const zeitTeil = rumpf.slice(0, ZEIT_STELLEN);
  const laufTeil = rumpf.slice(ZEIT_STELLEN, ZEIT_STELLEN + LAUF_STELLEN);
  return { zeit: parseInt(zeitTeil, 36), lauf: parseInt(laufTeil, 36) };
}

function bauen(prefix, zeit, lauf) {
  const zeitTeil = zeit.toString(36).padStart(ZEIT_STELLEN, '0');
  const laufTeil = lauf.toString(36).padStart(LAUF_STELLEN, '0');
  return `${prefix}${zeitTeil}${laufTeil}${'a'.repeat(ZUFALL_STELLEN)}`;
}

/** DAS ECHTE Altformat (vor dieser Ausgabe): Zeit + Zufall, OHNE die drei
    Laufnummer-Zeichen, die `bauen()` oben einfügt. `bauen()` allein beweist
    nichts über das Altformat — jede Kennung, die es erzeugt, hätte auch die
    heutige, korrigierte `markeAusKennung()` schon vor diesem Fix verstanden.
    Diese Funktion erzeugt stattdessen exakt das, was auf der Pi-Datenbank
    wirklich liegt: drei Zeichen kürzer, keine Laufnummer-Stelle. */
function bauenAlt(prefix, zeit) {
  const zeitTeil = zeit.toString(36).padStart(ZEIT_STELLEN, '0');
  return `${prefix}${zeitTeil}${'a'.repeat(ZUFALL_STELLEN)}`;
}

/** Einen Lauf gegen den Ordner `daten` starten, mit den gegebenen KENNUNG_*-Variablen. */
function minten(daten, vars) {
  const env = { ...process.env, DATA_DIR: daten };
  for (const [k, v] of Object.entries(vars)) {
    if (v === undefined) delete env[k];
    else env[k] = String(v);
  }
  const lauf = spawnSync('npx', ['tsx', 'src/pruefungen/kennung-mint.mts'], {
    cwd: serverOrdner, env, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024,
  });
  const stdout = lauf.stdout ?? '';
  const stderr = lauf.stderr ?? '';
  const zeilen = stdout.split('\n').filter((z) => z.trim().length > 0);
  const ok = lauf.status === 0 && zeilen.includes('MINT-OK');
  const ids = zeilen.filter((z) => z.startsWith('KENNUNG:')).map((z) => z.slice('KENNUNG:'.length));
  return { code: lauf.status, ids: ok ? ids : [], ok, stdout, stderr };
}

function ordnerAnlegen(basis, name) {
  const p = path.join(basis, name);
  fs.mkdirSync(p, { recursive: true });
  return p;
}

const arbeit = fs.mkdtempSync(path.join(os.tmpdir(), 'stellium-kennung-'));
try {
  /* ── 1: Uhr springt zurück — die nächste Kennung sortiert trotzdem darüber ── */
  sag(`\n${F.grau}Uhr springt zurück, innerhalb desselben Prozesses${F.aus}`);
  const ruecksprung = ordnerAnlegen(arbeit, 'ruecksprung');
  const t1 = minten(ruecksprung, { KENNUNG_ZEITEN: '2000000000000,1000000000000', KENNUNG_PREFIX: 'm_' });
  pruef('der Prozess läuft durch', t1.ok, t1.stderr.slice(-400));
  pruef('zwei Kennungen kommen zurück', t1.ids.length === 2, JSON.stringify(t1.ids));
  const [vor, nach] = t1.ids;
  pruef('die zweite Kennung sortiert ÜBER der ersten, obwohl die Uhr zurücksprang',
    Boolean(vor) && Boolean(nach) && nach > vor, `${vor} / ${nach}`);
  if (vor && nach) {
    const zVor = zerlegen('m_', vor);
    const zNach = zerlegen('m_', nach);
    pruef('beide tragen dieselbe (die ältere, nicht zurückgedrehte) Zeit',
      zVor.zeit === zNach.zeit, `${zVor.zeit} / ${zNach.zeit}`);
    pruef('die Laufnummer trägt die Reihenfolge statt der Zeit',
      zNach.lauf === zVor.lauf + 1, `${zVor.lauf} -> ${zNach.lauf}`);
  }
  pruef('die Meldung über die zurückliegende Uhr steht im Log (laut, nicht lautlos)',
    t1.stderr.includes('[id] Systemuhr liegt') && t1.stderr.includes('hinter der zuletzt vergebenen ID-Zeit'),
    t1.stderr.slice(-300));

  /* ── 2: viele Kennungen in derselben eingefrorenen Millisekunde ── */
  sag(`\n${F.grau}Viele Kennungen bei stehender Uhr — bleiben sie eindeutig UND sortierbar?${F.aus}`);
  const eingefroren = ordnerAnlegen(arbeit, 'eingefroren');
  const ANZAHL = 50_000; // > 46 656 (LAUF_GRENZE) — deckt auch das Überlaufen der Laufnummer ab
  const t2 = minten(eingefroren, { KENNUNG_ZEIT: '3000000000000', KENNUNG_ANZAHL: ANZAHL, KENNUNG_PREFIX: 'm_' });
  pruef('der Prozess läuft durch', t2.ok, t2.stderr.slice(-400));
  pruef(`${ANZAHL} Kennungen kommen zurück`, t2.ids.length === ANZAHL, String(t2.ids.length));
  const einzigartig = new Set(t2.ids);
  pruef('alle eindeutig, trotz eingefrorener Uhr über die Laufnummer-Grenze hinaus',
    einzigartig.size === t2.ids.length, `${einzigartig.size} von ${t2.ids.length}`);
  let steigendOk = true;
  for (let i = 1; i < t2.ids.length; i++) {
    if (!(t2.ids[i] > t2.ids[i - 1])) { steigendOk = false; break; }
  }
  pruef('jede Kennung sortiert strikt über der vorigen — auch übers Überlaufen der Laufnummer hinweg',
    steigendOk);

  /* ── 3: Neustart mit einer Uhr, die hinter dem letzten Datenbankstand liegt ── */
  sag(`\n${F.grau}Neustart — Wasserlinie kommt aus der Datenbank, nicht aus dem (toten) Prozess${F.aus}`);
  const neustart = ordnerAnlegen(arbeit, 'neustart');
  const T_ALT = 5_000_000_000_000; // „letzte Kennung vor dem Absturz"
  const T_BOOT = 1_000_000_000_000; // Uhrstand beim Hochfahren — weit dahinter
  const vorigerLauf = bauen('m_', T_ALT, 0);

  // Phase A: nur seeden (ein eigener, gleich wieder beendeter Prozess — die
  // Wasserlinie in DIESEM Prozess trägt nichts zu Phase B bei, absichtlich).
  const phaseA = minten(neustart, { KENNUNG_SEED: vorigerLauf, KENNUNG_ANZAHL: 0 });
  pruef('Phase A (seeden) läuft durch', phaseA.ok, phaseA.stderr.slice(-400));

  // Phase B: ein FRISCHER Prozess, Uhr steht weit vor T_ALT — die einzige
  // Quelle für „was war die letzte Kennung" ist jetzt die Datenbankdatei.
  const phaseB = minten(neustart, { KENNUNG_ZEIT: T_BOOT, KENNUNG_ANZAHL: 1 });
  pruef('Phase B (Neustart mit alter Uhr) läuft durch', phaseB.ok, phaseB.stderr.slice(-400));
  const nachNeustart = phaseB.ids[0];
  pruef('eine Kennung kommt zurück', Boolean(nachNeustart), JSON.stringify(phaseB.ids));
  if (nachNeustart) {
    const z = zerlegen('m_', nachNeustart);
    pruef('ihre Zeit ist die aus der Datenbank rekonstruierte (T_ALT), NICHT die zu alte Boot-Uhr',
      z.zeit === T_ALT, `${z.zeit} statt ${T_ALT} (Boot-Uhr wäre ${T_BOOT} gewesen)`);
    pruef('sie sortiert über der Kennung aus dem vorigen Lauf',
      nachNeustart > vorigerLauf, `${vorigerLauf} / ${nachNeustart}`);
    pruef('die Laufnummer setzt fort statt bei null neu anzufangen (gleiche Zeit wie der Seed)',
      z.lauf === 1, String(z.lauf));
  }
  pruef('die Meldung über die zurückliegende Uhr steht auch nach dem Neustart im Log',
    phaseB.stderr.includes('[id] Systemuhr liegt'), phaseB.stderr.slice(-300));

  /* ── 3c: derselbe Neustart, aber diesmal newIdMitZeit() statt newId() —
     zeigt, ob ein danebenliegendes `created_at` (etwa messages.created_at,
     siehe util/id.ts-Kopfkommentar) dieselbe geklemmte Zeit bekommt wie die
     `id` selbst, oder ob es (der ursprüngliche Fehler) aus einem zweiten,
     unabhängigen Date.now() käme und dabei die zu alte Boot-Uhr trüge, obwohl
     die `id` daneben schon auf der Wasserlinie steht. Derselbe Seed-Stand
     (vorigerLauf/T_ALT) wie Abschnitt 3, ein frischer Ordner, damit die
     beiden Läufe sich nicht gegenseitig die Wasserlinie verschieben. ── */
  sag(`\n${F.grau}newIdMitZeit(): geklemmte Zeit neben einer id, nicht aus einem eigenen Date.now()${F.aus}`);
  const neustartZeit = ordnerAnlegen(arbeit, 'neustart-mit-zeit');
  const phaseAZeit = minten(neustartZeit, { KENNUNG_SEED: vorigerLauf, KENNUNG_ANZAHL: 0 });
  pruef('Phase A (seeden) läuft durch', phaseAZeit.ok, phaseAZeit.stderr.slice(-400));
  const phaseBZeit = minten(neustartZeit, {
    KENNUNG_ZEIT: T_BOOT, KENNUNG_ANZAHL: 1, KENNUNG_MIT_ZEIT: 1,
  });
  pruef('Phase B (Neustart mit alter Uhr, newIdMitZeit()) läuft durch', phaseBZeit.ok, phaseBZeit.stderr.slice(-400));
  const [idMitZeit, zeitRoh] = (phaseBZeit.ids[0] ?? '').split('|');
  const zeitZurueck = Number(zeitRoh);
  pruef('eine Kennung samt Zeit kommt zurück', Boolean(idMitZeit) && Number.isFinite(zeitZurueck), JSON.stringify(phaseBZeit.ids));
  pruef('die zurückgegebene Zeit ist die geklemmte Wasserlinie (T_ALT), NICHT die zu alte Boot-Uhr',
    zeitZurueck === T_ALT, `${zeitZurueck} statt ${T_ALT} (Boot-Uhr wäre ${T_BOOT} gewesen — genau der Fehler, den ein eigener Date.now() für created_at hätte)`);
  if (idMitZeit) {
    const z = zerlegen('m_', idMitZeit);
    pruef('dieselbe Zeit steckt auch in der id selbst — id und created_at aus EINER Vergabe, nicht zwei',
      z.zeit === zeitZurueck, `id trägt ${z.zeit}, zurückgegeben wurde ${zeitZurueck}`);
  }

  /* ── 3b: derselbe Neustart, aber die letzte Kennung vor dem Absturz ist eine
     ECHTE Altformat-Kennung — genau das, was auf der Pi-Datenbank tatsächlich
     liegt, nicht eine von bauen() erzeugte (die trägt schon die neuen drei
     Laufnummer-Zeichen und hätte den Fehler nie gezeigt). Zwei Präfix-Längen,
     weil der Fehlerbericht zwei VERSCHIEDENE Ursachen für dieselbe Blindheit
     nennt: `m_` (2 Zeichen) scheitert an der Längenprüfung, `po_` (3 Zeichen)
     ist zufällig lang genug, aber die Ziffernfelder landen verschoben und der
     Unterstrich lässt die Basis-36-Prüfung scheitern. */
  sag(`\n${F.grau}Neustart mit einer ECHTEN Altformat-Kennung (kein Laufnummer-Zeichen) als letzter Zeile vor dem Absturz${F.aus}`);
  for (const praefix of ['m_', 'po_']) {
    sag(`  ${F.grau}Präfix "${praefix}"${F.aus}`);
    const neustartAlt = ordnerAnlegen(arbeit, `neustart-alt-${praefix.replace('_', '')}`);
    const T_ALT2 = 6_000_000_000_000;
    const T_BOOT2 = 2_000_000_000_000;
    const vorigerLaufAlt = bauenAlt(praefix, T_ALT2);
    pruef('  die gebaute Altformat-Kennung ist tatsächlich LAUF_STELLEN Zeichen kürzer als eine neue',
      vorigerLaufAlt.length === bauen(praefix, T_ALT2, 0).length - LAUF_STELLEN,
      `${vorigerLaufAlt.length} vs. ${bauen(praefix, T_ALT2, 0).length}`);

    const phaseAAlt = minten(neustartAlt, { KENNUNG_SEED: vorigerLaufAlt, KENNUNG_ANZAHL: 0 });
    pruef('  Phase A (Altformat seeden) läuft durch', phaseAAlt.ok, phaseAAlt.stderr.slice(-400));

    const phaseBAlt = minten(neustartAlt, { KENNUNG_ZEIT: T_BOOT2, KENNUNG_ANZAHL: 1, KENNUNG_PREFIX: praefix });
    pruef('  Phase B (Neustart mit alter Uhr, echter Altformat-Vorlauf) läuft durch',
      phaseBAlt.ok, phaseBAlt.stderr.slice(-400));
    const nachNeustartAlt = phaseBAlt.ids[0];
    pruef('  eine Kennung kommt zurück', Boolean(nachNeustartAlt), JSON.stringify(phaseBAlt.ids));
    if (nachNeustartAlt) {
      const z = zerlegen(praefix, nachNeustartAlt);
      // +1: markeAusKennung() hebt eine rekonstruierte Altformat-Zeit bewusst um eine
      // Millisekunde an (siehe util/id.ts) -- sonst könnte der alte, an dieser Stelle
      // stehende Zufallsanteil lexikalisch über die neue Laufnummer geraten.
      pruef('  ihre Zeit ist die aus der ECHTEN Altformat-Kennung rekonstruierte (T_ALT2 + 1), NICHT die zu alte Boot-Uhr',
        z.zeit === T_ALT2 + 1, `${z.zeit} statt ${T_ALT2 + 1} (Boot-Uhr wäre ${T_BOOT2} gewesen)`);
      pruef('  sie sortiert über der Altformat-Kennung aus dem vorigen Lauf',
        nachNeustartAlt > vorigerLaufAlt, `${vorigerLaufAlt} / ${nachNeustartAlt}`);
      // Laufnummer startet bei der rekonstruierten Marke bei 0 (die Altformat-Kennung
      // hatte gar keine), zählt aber im selben newId()-Aufruf sofort auf 1 weiter, weil
      // die Uhr noch immer <= der (angehobenen) Wasserlinie steht -- derselbe Ablauf wie
      // beim Neustart mit einer NEUEN Vorlauf-Kennung oben ("setzt fort statt bei null").
      pruef('  die Laufnummer zählt sofort auf 1 weiter (dieselbe Millisekunde wie die angehobene Wasserlinie)',
        z.lauf === 1, String(z.lauf));
    }
    pruef('  die Meldung über die zurückliegende Uhr steht auch nach diesem Neustart im Log',
      phaseBAlt.stderr.includes('[id] Systemuhr liegt'), phaseBAlt.stderr.slice(-300));
    pruef('  KEINE Warnung über eine unlesbare höchste Kennung -- das Altformat wird verstanden, nicht verworfen',
      !phaseBAlt.stderr.includes('passt zu keinem bekannten Format'), phaseBAlt.stderr.slice(-300));
  }

  /* ── 4: der normale Fall — Uhr läuft vor, nichts davon greift ── */
  sag(`\n${F.grau}Normalfall: Uhr läuft ganz gewöhnlich vor — unbeeinflusst${F.aus}`);
  const T_NORMAL = T_ALT + 5000;
  const phaseC = minten(neustart, { KENNUNG_ZEIT: T_NORMAL, KENNUNG_ANZAHL: 1 });
  pruef('Phase C (normaler Weiterlauf) läuft durch', phaseC.ok, phaseC.stderr.slice(-400));
  const normal = phaseC.ids[0];
  if (normal) {
    const z = zerlegen('m_', normal);
    pruef('Zeit ist genau die (voranschreitende) Systemuhr', z.zeit === T_NORMAL, `${z.zeit} statt ${T_NORMAL}`);
    pruef('Laufnummer bleibt bei 0 — kein eingefrorenes Fenster, keine künstliche Verzögerung',
      z.lauf === 0, String(z.lauf));
    pruef('sortiert über allem Bisherigen aus diesem Ordner', normal > nachNeustart, `${nachNeustart} / ${normal}`);
  }
  pruef('keine Meldung über eine zurückliegende Uhr — die Uhr lag hier nie zurück',
    !phaseC.stderr.includes('[id] Systemuhr liegt'), phaseC.stderr.slice(-300));

  /* ── 5: frische, leere Datenbank — kein Absturz ohne jeden Vorlauf ── */
  sag(`\n${F.grau}Frische Datenbank ganz ohne Vorlauf${F.aus}`);
  const frisch = ordnerAnlegen(arbeit, 'frisch');
  const t5 = minten(frisch, {});
  pruef('läuft ohne jede Startmarke einfach durch', t5.ok && t5.ids.length === 1, t5.stderr.slice(-400));

  /* ── 6: eine Tabelle mit Zeilen, aber keine davon in einem bekannten Format
     -- die Wasserlinie darf HIER bei 0 bleiben (kein anderer Weg), aber
     lautlos ist das falsch: genau das ist der Rückstufungsfall aus dem
     Auftrag. Muss laut sein, nicht bloß `continue`n. ── */
  sag(`\n${F.grau}Höchste Kennung passt zu keinem bekannten Format -- Wasserlinie bleibt 0, aber LAUT${F.aus}`);
  const unlesbar = ordnerAnlegen(arbeit, 'unlesbar');
  const t6 = minten(unlesbar, { KENNUNG_SEED: 'nicht-irgendwie-eine-kennung', KENNUNG_ANZAHL: 1 });
  pruef('der Prozess läuft trotzdem durch, statt abzustürzen', t6.ok, t6.stderr.slice(-400));
  pruef('eine Kennung kommt trotzdem zurück', t6.ids.length === 1, JSON.stringify(t6.ids));
  pruef('die Warnung über die unlesbare höchste Kennung steht im Log',
    t6.stderr.includes('[id]') && t6.stderr.includes('passt zu keinem bekannten Format')
      && t6.stderr.includes('nicht-irgendwie-eine-kennung'),
    t6.stderr.slice(-400));
} finally {
  fs.rmSync(arbeit, { recursive: true, force: true });
}

sag(fehler
  ? `\n${F.rot}${fehler} fehlgeschlagen${F.aus}\n`
  : `\n${F.gruen}Kennungen bleiben sortierbar und eindeutig, auch wenn die Systemuhr beim Start zurückliegt.${F.aus}\n`);
process.exit(fehler ? 1 : 0);
