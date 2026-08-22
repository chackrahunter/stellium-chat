#!/usr/bin/env node
/**
 * Erzeugt den Emoji-Namensbestand für die Suche im EmojiPicker und für die
 * örtlichen Reaktionsvorschläge (siehe packages/desktop/src/emoji/katalog.ts).
 *
 *   node scripts/emoji-katalog-erzeugen.mjs
 *
 * WOHER DIE NAMEN KOMMEN
 *
 * Aus `emojibase-data` (MIT-Lizenz, © Miles Johnson, github.com/milesj/emojibase),
 * das die CLDR-Kurznamen und -Stichwörter von Unicode je Sprache aufbereitet.
 * Das Paket ist NICHT Teil dieses Projekts — es wird nur einmalig zum Erzeugen
 * gebraucht, nie zur Laufzeit. Ein `npm install` dieses Skripts in den
 * eigentlichen Baum würde package.json/package-lock.json anfassen, und genau
 * das soll hier vermieden werden (mehrere Leute arbeiten am selben Baum).
 * Stattdessen:
 *
 *   1. In einem Ordner AUSSERHALB des Projekts (z.B. /tmp):
 *        npm pack emojibase-data@17 --silent && tar xzf emojibase-data-*.tgz
 *   2. Hier aufrufen:
 *        node scripts/emoji-katalog-erzeugen.mjs --von /tmp/package
 *      (Ohne --von wird node_modules/emojibase-data im Projekt versucht, falls
 *      jemand es dort einmal testweise installiert hat.)
 *
 * Das Ergebnis sind feste Dateien unter packages/desktop/src/emoji/daten/ —
 * eingecheckt, nie zur Laufzeit nachgeladen von emojibase selbst. Nur wer den
 * Emoji-Bestand in EmojiPicker.tsx (GROUPS) ändert oder eine weitere Sprache
 * aufnehmen will, muss dieses Skript je wieder ausführen.
 *
 * WARUM NUR DIE ~70 EMOJI DES PICKERS UND NICHT ALLE ~5000 VON UNICODE
 *
 * emojibase-data liefert pro Sprache 700-800 KB (siehe data.json) — für ein
 * Firmen-Chat-Programm auf einem Raspberry Pi und in einer Electron-App, das
 * bei jedem Sprachwechsel neu geladen würde, unverhältnismäßig viel Gewicht
 * für einen Namensbestand. Der EmojiPicker zeigt ohnehin nur eine bewusst
 * kuratierte Auswahl (fünf Gruppen, siehe GROUPS in EmojiPicker.tsx) — jede
 * erzeugte Sprachdatei enthält darum nur Name+Stichwörter GENAU dieser Emoji,
 * nichts sonst. Ergebnis: 2-4 KB je Sprache statt 700+ KB.
 *
 * WELCHE SPRACHEN
 *
 * emojibase-data deckt 18 der 22 Oberflächensprachen ab. Es fehlen: Tschechisch
 * (cs), Rumänisch (ro), Türkisch (tr), Arabisch (ar) — für sie wird keine Datei
 * erzeugt, und packages/desktop/src/emoji/katalog.ts fällt zur Laufzeit auf
 * Englisch zurück (siehe dort). Norwegisch (no) wird auf die einzige in
 * emojibase-data geführte Variante "nb" (Bokmål) abgebildet.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const wurzel = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const zielOrdner = path.join(wurzel, 'packages/desktop/src/emoji/daten');
const pickerDatei = path.join(wurzel, 'packages/desktop/src/components/EmojiPicker.tsx');

const F = { aus: '\x1b[0m', fett: '\x1b[1m', grau: '\x1b[90m', gruen: '\x1b[38;5;42m', rot: '\x1b[38;5;203m', gelb: '\x1b[38;5;220m' };
const sag = (t = '') => process.stdout.write(`${t}\n`);
const raus = (t) => { sag(`\n${F.rot}✗ ${t}${F.aus}\n`); process.exit(1); };

/* ── Woher emojibase-data kommt ──────────────────────────────── */

const vonArg = process.argv.indexOf('--von');
const quellOrdner = vonArg !== -1 && process.argv[vonArg + 1]
  ? path.resolve(process.argv[vonArg + 1])
  : path.join(wurzel, 'node_modules/emojibase-data');

if (!fs.existsSync(quellOrdner)) {
  raus([
    `emojibase-data nicht gefunden unter ${quellOrdner}.`,
    'Siehe Kopfkommentar dieses Skripts: erst außerhalb des Projekts entpacken,',
    'dann mit --von <Ordner> hierher zeigen. Es wird NICHT in dieses Projekt',
    'installiert (package.json bleibt unberührt).',
  ].join('\n'));
}

/* ── Die 72 Emoji des Pickers, aus der Quelle selbst gelesen ───
   Eine zweite, abgeschriebene Liste hier wäre nach der nächsten Änderung an
   GROUPS still falsch — deshalb wird EmojiPicker.tsx direkt gelesen. */

function pickerEmojiListe() {
  const text = fs.readFileSync(pickerDatei, 'utf8');
  const block = /const GROUPS[\s\S]*?\n\];/.exec(text);
  if (!block) raus('GROUPS nicht in EmojiPicker.tsx gefunden — Bauart dort geändert?');
  const emojiArrays = [...block[0].matchAll(/emoji:\s*\[([^\]]+)\]/g)];
  if (!emojiArrays.length) raus('Keine emoji:[...]-Listen in GROUPS gefunden.');
  const alle = emojiArrays.flatMap((m) => [...m[1].matchAll(/'([^']+)'/g)].map((x) => x[1]));
  return [...new Set(alle)];
}

/** Codepunkte ohne Darstellungs-Auswahlzeichen (VS15/VS16) — für den Abgleich. */
function normHex(emoji) {
  return [...emoji]
    .map((z) => z.codePointAt(0))
    .filter((cp) => cp !== 0xfe0e && cp !== 0xfe0f)
    .map((cp) => cp.toString(16).toUpperCase())
    .join('-');
}

/* ── Sprachzuordnung: Stellium-Code -> emojibase-Ordner ────────
   Stellium führt 22 Oberflächensprachen (packages/shared/src/languages.ts).
   emojibase-data führt eigene Locale-Ordner; die Zuordnung ist meist 1:1,
   bei Norwegisch nicht (nur "nb" vorhanden, kein reines "no"). */
const SPRACH_ZUORDNUNG = {
  de: 'de', en: 'en', fr: 'fr', es: 'es', it: 'it', pt: 'pt', nl: 'nl',
  pl: 'pl', ru: 'ru', uk: 'uk', hi: 'hi', zh: 'zh', ja: 'ja', ko: 'ko',
  sv: 'sv', da: 'da', fi: 'fi', no: 'nb',
  // Bewusst NICHT aufgeführt (siehe Kopfkommentar): cs, ro, tr, ar.
};

function main() {
  const emojiListe = pickerEmojiListe();
  sag(`${F.fett}Emoji im Picker:${F.aus} ${emojiListe.length} (nach Dubletten)`);
  sag(`${F.grau}Quelle: ${quellOrdner}${F.aus}\n`);

  fs.mkdirSync(zielOrdner, { recursive: true });

  const zusammenfassung = [];

  for (const [stelliumCode, emojibaseCode] of Object.entries(SPRACH_ZUORDNUNG)) {
    const datenDatei = path.join(quellOrdner, emojibaseCode, 'data.json');
    if (!fs.existsSync(datenDatei)) {
      sag(`${F.gelb}⚠ ${stelliumCode}: keine Datei ${datenDatei} — übersprungen${F.aus}`);
      continue;
    }
    /** @type {Array<{label:string; tags?:string[]; emoji:string}>} */
    const rohdaten = JSON.parse(fs.readFileSync(datenDatei, 'utf8'));

    const nachHex = new Map();
    for (const eintrag of rohdaten) {
      if (!eintrag.emoji || !eintrag.label) continue;
      nachHex.set(normHex(eintrag.emoji), eintrag);
    }

    const bestand = {};
    const fehlend = [];
    for (const emoji of emojiListe) {
      const treffer = nachHex.get(normHex(emoji));
      if (!treffer) { fehlend.push(emoji); continue; }
      /* Groß-/Kleinschreibung raus beim Vergleich (CLDR führt "Daumen hoch" als
         Anzeigename UND "daumen hoch" als eigenes Stichwort) — behalten wird
         die erste Schreibweise, meist der Anzeigename selbst. */
      const rohListe = [treffer.label, ...(treffer.tags ?? [])].map((s) => s.trim()).filter(Boolean);
      const gesehen = new Set();
      const keywords = [];
      for (const s of rohListe) {
        const schluessel = s.toLowerCase();
        if (gesehen.has(schluessel)) continue;
        gesehen.add(schluessel);
        keywords.push(s);
      }
      bestand[emoji] = { name: treffer.label, keywords };
    }

    const zeilen = Object.entries(bestand)
      .map(([emoji, e]) => `  ${JSON.stringify(emoji)}: ${JSON.stringify(e)},`)
      .join('\n');

    const ausgabe = `/**
 * Emoji-Namen und Suchbegriffe — ${stelliumCode.toUpperCase()}.
 *
 * ERZEUGT von scripts/emoji-katalog-erzeugen.mjs aus emojibase-data
 * (MIT-Lizenz, © Miles Johnson — github.com/milesj/emojibase, CLDR-Grundlage).
 * Nicht von Hand ändern — neu erzeugen: node scripts/emoji-katalog-erzeugen.mjs
 *
 * Nur die im EmojiPicker tatsächlich gezeigten Emoji, nicht der volle
 * Unicode-Bestand — siehe Kopfkommentar des Erzeuger-Skripts fürs Warum.
 */
import type { EmojiKatalog } from '../typen.js';

const daten: EmojiKatalog = {
${zeilen}
};

export default daten;
`;

    fs.writeFileSync(path.join(zielOrdner, `${stelliumCode}.ts`), ausgabe, 'utf8');

    const status = fehlend.length === 0
      ? `${F.gruen}${Object.keys(bestand).length}/${emojiListe.length}${F.aus}`
      : `${F.gelb}${Object.keys(bestand).length}/${emojiListe.length} — fehlen: ${fehlend.join(' ')}${F.aus}`;
    sag(`  ${stelliumCode.padEnd(4)} (${emojibaseCode.padEnd(5)}) ${status}`);
    zusammenfassung.push({ stelliumCode, treffer: Object.keys(bestand).length, gesamt: emojiListe.length });
  }

  const fehlendeSprachen = alleOberflaechensprachen().filter((c) => !SPRACH_ZUORDNUNG[c]);
  sag(`\n${F.grau}Ohne erzeugte Datei (Rückfall auf Englisch zur Laufzeit): ${fehlendeSprachen.join(', ') || '(keine)'}${F.aus}`);
  sag(`${F.gruen}Fertig.${F.aus} ${zusammenfassung.length} Sprachdateien in ${path.relative(wurzel, zielOrdner)}/\n`);
}

/** Die 22 Oberflächensprachen, ohne packages/shared zu importieren (reines Node-Skript, kein Build nötig). */
function alleOberflaechensprachen() {
  return [
    'de', 'en', 'fr', 'es', 'it', 'pt', 'nl', 'pl', 'cs', 'ro', 'tr',
    'ru', 'uk', 'ar', 'hi', 'zh', 'ja', 'ko', 'sv', 'da', 'fi', 'no',
  ];
}

main();
