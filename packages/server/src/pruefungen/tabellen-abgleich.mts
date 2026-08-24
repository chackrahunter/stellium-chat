/**
 * Zwei Definitionen für dieselbe neu hinzugekommene Tabelle sind in diesem
 * Haus Absicht, nicht Versehen: schema.sql legt eine solche Tabelle für die
 * FRISCHE Installation an, migrate.ts dieselbe Tabelle noch einmal für eine
 * BESTEHENDE Datenbank — weil `CREATE TABLE IF NOT EXISTS` in schema.sql nur
 * zuverlässig durchläuft, wenn keine frühere Anweisung in derselben Datei
 * auf einer alten Datenbank stolpert und den ganzen Lauf mitreißt (siehe
 * db/index.ts, initDb()/sqlAnweisungen()). migrate.ts sagt das bei jeder
 * dieser Tabellen auch selbst so ("Wortgleich mit dort").
 *
 * "Wortgleich" ist aber ein Versprechen, kein Mechanismus — und genau ein
 * von Hand gepflegtes Versprechen zwischen ZWEI Stellen ist die Bauart, die
 * rebuildUsersTable() (db/migrate.ts) in dieser Prüfkampagne schon DREIMAL
 * auseinanderlaufen sah, zuletzt an `timezone_auto`. Dort ließ sich die
 * zweite Liste ersatzlos streichen (abgeleitet aus der lebenden Tabelle,
 * siehe dort). Hier geht das nicht: die Tabelle, die migrate.ts anlegt,
 * existiert im Moment des Anlegens per Definition noch NICHT — es gibt
 * nichts Lebendes, von dem sich ableiten ließe. Diese Prüfung ersetzt die
 * fehlende Ableitung durch einen Wächter: sie findet JEDE Tabelle, die in
 * BEIDEN Dateien per `CREATE TABLE IF NOT EXISTS` entsteht — ohne feste
 * Namensliste, eine künftig hinzukommende doppelt geführte Tabelle wird
 * automatisch mitgeprüft — und vergleicht ihre Spaltenlisten ohne
 * Kommentare und Einrückung. Weicht eine ab, schlägt die Prüfung fehl,
 * BEVOR eine solche Datenbank überhaupt entsteht.
 *
 * Läuft ohne Datenbank — reiner Textvergleich der beiden Quelldateien.
 *
 * Aufruf:  node scripts/tabellen-abgleich-pruefen.mjs
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { maskieren } from '../db/index.js';

const hier = path.dirname(fileURLToPath(import.meta.url));
const wurzel = path.resolve(hier, '..', '..'); // packages/server

const schemaPfad = path.join(wurzel, 'src/db/schema.sql');
const migratePfad = path.join(wurzel, 'src/db/migrate.ts');
const schemaText = fs.readFileSync(schemaPfad, 'utf8');
const migrateText = fs.readFileSync(migratePfad, 'utf8');

/**
 * Alle per `CREATE TABLE IF NOT EXISTS <name> (` eingeführten Tabellennamen
 * in einem Text — funktioniert unverändert für schema.sql (reines SQL) UND
 * für migrate.ts (SQL in Template-Strings): das Suchmuster kennt nur die
 * SQL-Anweisung selbst, nicht die Sprache drumherum.
 */
function tabellenNamen(text: string): string[] {
  const namen: string[] = [];
  const muster = /CREATE TABLE IF NOT EXISTS\s+(\w+)\s*\(/gi;
  let treffer: RegExpExecArray | null;
  while ((treffer = muster.exec(text))) namen.push(treffer[1]);
  return namen;
}

/**
 * Die Spaltenliste einer bestimmten Tabelle aus ihrem CREATE TABLE
 * herausschneiden — von der öffnenden bis zur passenden schließenden
 * Klammer, klammertief gezählt auf der MASKIERTEN (kommentar- und
 * string-freien) Fassung, damit eine Klammer in einem Kommentar oder einem
 * Text-Default nicht als Ende zählt. Zurückgegeben wird trotzdem der
 * UNMASKIERTE Originaltext dieses Abschnitts — die Maskierung dient hier nur
 * dem Auffinden der Grenze, nicht dem Ergebnis.
 */
function spaltenliste(text: string, tabelle: string): string | null {
  const muster = new RegExp(`CREATE TABLE IF NOT EXISTS\\s+${tabelle}\\s*\\(`, 'i');
  const treffer = muster.exec(text);
  if (!treffer) return null;
  const klammerAuf = treffer.index + treffer[0].length - 1;
  const maske = maskieren(text);
  let tiefe = 1;
  let i = klammerAuf + 1;
  while (i < text.length && tiefe > 0) {
    if (maske[i] === '(') tiefe++;
    else if (maske[i] === ')') tiefe--;
    i++;
  }
  if (tiefe !== 0) return null; // keine passende schließende Klammer gefunden
  return text.slice(klammerAuf + 1, i - 1);
}

/**
 * NUR Kommentare heraus (Zeilen- und Blockkommentare), Zeichenketten bleiben
 * UNVERÄNDERT stehen — anders als maskieren() oben, das für seinen eigenen
 * Zweck (Klammern/Semikola sicher finden) auch Zeichenketten leert. Hier
 * zählt gerade der Inhalt von Zeichenketten mit: eine verschobene
 * DEFAULT-Zeichenkette (z. B. `DEFAULT 'wissen'` vs. `DEFAULT 'Wissen'`)
 * soll die Prüfung genauso stolpern lassen wie ein anderer Spaltenname.
 */
function nurKommentareRaus(sql: string): string {
  let out = '';
  let i = 0;
  const n = sql.length;
  while (i < n) {
    if (sql[i] === '-' && sql[i + 1] === '-') {
      const ende = sql.indexOf('\n', i);
      i = ende === -1 ? n : ende; // der Zeilenumbruch selbst bleibt erhalten
    } else if (sql[i] === '/' && sql[i + 1] === '*') {
      const ende = sql.indexOf('*/', i + 2);
      i = ende === -1 ? n : ende + 2;
      out += ' ';
    } else if (sql[i] === "'" || sql[i] === '"') {
      const anfuehrung = sql[i];
      let j = i + 1;
      for (;;) {
        const q = sql.indexOf(anfuehrung, j);
        if (q === -1) { j = n; break; }
        if (sql[q + 1] === anfuehrung) { j = q + 2; continue; } // verdoppelt: String geht weiter
        j = q + 1;
        break;
      }
      out += sql.slice(i, j); // Zeichenkette unverändert übernehmen
      i = j;
    } else {
      out += sql[i];
      i++;
    }
  }
  return out;
}

/** Kommentare raus, Weißraum auf ein Leerzeichen eingedampft — zwei Texte,
 *  die sich nur in Kommentaren oder Einrückung unterscheiden, gelten damit
 *  als gleich. Was wirklich zählt (Spaltennamen, Typen, NOT NULL, DEFAULT
 *  samt Wert, Reihenfolge, Fremdschlüssel), bleibt erhalten. */
function normalisiert(spalten: string): string {
  return nurKommentareRaus(spalten).replace(/\s+/g, ' ').replace(/\s*,\s*/g, ', ').trim();
}

let fehler = 0;
const pruef = (name: string, ist: unknown, soll: unknown) => {
  const ok = JSON.stringify(ist) === JSON.stringify(soll);
  if (!ok) fehler++;
  console.log(`  ${ok ? '\x1b[32m✓\x1b[0m' : '\x1b[31m✗\x1b[0m'} ${name}${ok ? '' : `\n     ist:  ${JSON.stringify(ist)}\n     soll: ${JSON.stringify(soll)}`}`);
};

const inSchema = new Set(tabellenNamen(schemaText));
const inMigrate = new Set(tabellenNamen(migrateText));
const inBeiden = [...inSchema].filter((t) => inMigrate.has(t)).sort();

console.log(`Tabellen per CREATE TABLE IF NOT EXISTS: ${inSchema.size} in schema.sql, ${inMigrate.size} in migrate.ts, ${inBeiden.length} in beiden.\n`);
pruef('mail_wissen steht in beiden Dateien (der Anlass dieser Prüfung)', inBeiden.includes('mail_wissen'), true);
pruef('mail_wissen_vorschlaege steht in beiden Dateien', inBeiden.includes('mail_wissen_vorschlaege'), true);

for (const tabelle of inBeiden) {
  const ausSchema = spaltenliste(schemaText, tabelle);
  const ausMigrate = spaltenliste(migrateText, tabelle);
  if (ausSchema === null || ausMigrate === null) {
    fehler++;
    console.log(`  \x1b[31m✗\x1b[0m ${tabelle}: Spaltenliste ließ sich nicht sauber herausschneiden (fehlende schließende Klammer?) — von Hand prüfen.`);
    continue;
  }
  pruef(`${tabelle}: schema.sql und migrate.ts tragen dieselbe Spaltenliste`, normalisiert(ausMigrate), normalisiert(ausSchema));
}

console.log(fehler
  ? `\n\x1b[31m${fehler} fehlgeschlagen\x1b[0m\n`
  : '\n\x1b[32mJede doppelt geführte Tabelle trägt an beiden Stellen dieselbe Spaltenliste.\x1b[0m\n');
process.exit(fehler ? 1 : 0);
