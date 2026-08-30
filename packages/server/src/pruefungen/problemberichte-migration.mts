/**
 * Zweite Hälfte der Problemberichte-Prüfung, absichtlich ein EIGENER
 * PROZESS: problemberichte.mts hat den `DATA_DIR` dieses Laufs zurückgelassen
 * mit einer Datenbank, die schon alles trägt (Konten, Berichte) — NUR die
 * Tabelle `problemberichte` selbst hat sie am Ende per DROP wieder verloren.
 * Genau das ist der Zustand einer Datenbank, die 34 Fassungen läuft und
 * dieser Tabelle noch nie begegnet ist.
 *
 * `initDb()` hier ist ein frischer Aufruf in einem frischen Prozess — ein
 * echter Neustart, kein zweiter Aufruf im selben Lauf (der stolpert über
 * migrate()s einmalige Aufräumschritte, siehe problemberichte.mts). Läuft
 * migrate() dabei durch und legt die Tabelle wieder an, beweist das genau
 * die Zusicherung aus dem Auftrag: „die Migration muss auf dem nächsten
 * Neustart greifen, ohne manuellen Schritt".
 *
 * Aufruf: node scripts/problemberichte-pruefen.mjs (ruft diese Datei als
 * zweiten Schritt, mit demselben DATA_DIR wie problemberichte.mts).
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { db, initDb } from '../db/index.js';

let fehler = 0;
const pruef = (name: string, ist: unknown, soll: unknown) => {
  const ok = JSON.stringify(ist) === JSON.stringify(soll);
  if (!ok) fehler++;
  console.log(`  ${ok ? '\x1b[32m✓\x1b[0m' : '\x1b[31m✗\x1b[0m'} ${name}${ok ? '' : `\n     ist:  ${JSON.stringify(ist)}\n     soll: ${JSON.stringify(soll)}`}`);
};

/**
 * Statische Gegenprobe, VOR jedem Datenbankzugriff: `initDb()` führt heute
 * auch schema.sql selbst je Anweisung einzeln aus (db/index.ts,
 * sqlAnweisungen()) — auf einer Datenbank, die sonst vollständig ist, legt
 * DESSEN „CREATE TABLE IF NOT EXISTS problemberichte" die Tabelle beim
 * Neustart also SCHON ALLEIN wieder an, auch ganz OHNE die Zeile in
 * migrate.ts (nachgemessen beim Schreiben dieses Laufs). Der Rundgang unten
 * bewiese die geforderte Zusicherung („die Migration greift auf dem
 * nächsten Neustart") also selbst dann, wenn jemand den Block aus
 * migrate.ts wieder herausnähme — genau die Art Lücke, die dieser
 * Textvergleich schließt: er verlangt die Zeile dort UNABHÄNGIG davon, ob
 * der Rundgang unten aus einem anderen Grund ohnehin grün wäre.
 */
const migrateQuelle = fs.readFileSync(
  path.join(path.dirname(fileURLToPath(import.meta.url)), '../db/migrate.ts'), 'utf8',
);
pruef('migrate.ts trägt "CREATE TABLE IF NOT EXISTS problemberichte" (nicht nur schema.sql)',
  /CREATE TABLE IF NOT EXISTS\s+problemberichte\s*\(/.test(migrateQuelle), true);

initDb(); // ruft migrate() genau einmal auf, wie bei einem echten Serverstart

console.log('\nMigration auf einer Datenbank, die problemberichte noch nicht kennt');

const irgendeinNutzer = db.get<{ id: string }>('SELECT id FROM users LIMIT 1');
pruef('die alte Datenbank (Konten aus dem ersten Prozess) ist noch da', Boolean(irgendeinNutzer), true);

let ergebnis: unknown;
try {
  db.run(
    `INSERT INTO problemberichte
       (id, bereich, schwere, status, erwartet, passiert, panel, ui_sprache, created_by, created_at, updated_at)
     VALUES ('pb_migrationsprobe','chat','kleinigkeit','neu','Erwartet','Passiert','chat','de',?,?,?)`,
    irgendeinNutzer!.id, Date.now(), Date.now(),
  );
  ergebnis = db.get<{ id: string }>(`SELECT id FROM problemberichte WHERE id = 'pb_migrationsprobe'`)?.id;
} catch (err) {
  ergebnis = `fehlgeschlagen: ${(err as Error).message}`;
}
pruef('migrate() hat die Tabelle beim Neustart neu angelegt — ein Datensatz lässt sich schreiben und lesen',
  ergebnis, 'pb_migrationsprobe');

console.log(fehler
  ? `\n\x1b[31m${fehler} fehlgeschlagen\x1b[0m\n`
  : '\n\x1b[32mDie Migration trägt problemberichte auf einer bestehenden Datenbank ohne manuellen Schritt nach.\x1b[0m\n');
process.exit(fehler ? 1 : 0);
