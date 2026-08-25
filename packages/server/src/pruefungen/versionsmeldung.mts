/**
 * Wer sich zuletzt mit welcher App-Fassung angemeldet hat — Anlass war eine
 * Support-Rückfrage ("ich habe die neue Version noch nicht"), die sich von
 * der Verwaltung aus bisher nicht nachprüfen ließ (siehe
 * ManagedUser.clientVersion in @stellium/shared, services/store.ts
 * clientMeldung()/listManagedUsers(), services/releases.ts clientAktuell()
 * und ws/gateway.ts authenticate()).
 *
 * Geprüft wird:
 *  - eine Anmeldung MIT appVersion schreibt den Datensatz.
 *  - eine Anmeldung OHNE appVersion (älterer Client) überschreibt einen
 *    bekannten Stand nicht — und legt für ein Konto ohne Vorgeschichte auch
 *    nichts an.
 *  - "aktuell vs. veraltet" nutzt dieselbe istNeuer()-Prüfung wie
 *    /api/releases/check, an einer echten Grenze.
 *  - 'browser' vergleicht gegen config.version, nicht gegen die
 *    releases-Tabelle (dort gibt es keine Zeile für 'browser').
 *  - die Auskunft steht NUR auf ManagedUser — toUser()/toSelf() (das, was
 *    jede andere Person bzw. man selbst über sich sieht) trägt sie nicht.
 *
 * Läuft gegen eine WEGWERFBARE Datenbank — siehe scripts/versionsmeldung-
 * pruefen.mjs, dasselbe Muster wie bei lesebestaetigung-abschalten.mts.
 * NIEMALS direkt ohne eigenes DATA_DIR aufrufen: das Skript legt Zeilen in
 * `releases` an und löscht dort platformweise — gegen die echte Datenbank
 * wäre das ein Datenverlust.
 *
 * Aufruf:  node scripts/versionsmeldung-pruefen.mjs
 */
import { db, initDb } from '../db/index.js';
import * as store from '../services/store.js';
import * as releases from '../services/releases.js';
import { config } from '../config.js';

initDb();

let fehler = 0;
const pruef = (name: string, ist: unknown, soll: unknown) => {
  const ok = JSON.stringify(ist) === JSON.stringify(soll);
  if (!ok) fehler++;
  console.log(`  ${ok ? '\x1b[32m✓\x1b[0m' : '\x1b[31m✗\x1b[0m'} ${name}${ok ? '' : `  ${JSON.stringify(ist)} statt ${JSON.stringify(soll)}`}`);
};

db.run(`INSERT OR IGNORE INTO users (id, handle, display_name, password_hash, created_at)
        VALUES ('probe-vm-alice', 'probe-vm-alice', 'Alice', 'x', 0)`);
db.run(`INSERT OR IGNORE INTO users (id, handle, display_name, password_hash, created_at)
        VALUES ('probe-vm-bob', 'probe-vm-bob', 'Bob', 'x', 0)`);
// Deterministischer Ausgangspunkt, auch wenn dieser Lauf schon einmal gegen
// dieselbe Datenbank lief (INSERT OR IGNORE übergeht dann das Anlegen oben).
db.run(`UPDATE users SET client_version = NULL, client_platform = NULL, client_version_at = NULL
        WHERE id IN ('probe-vm-alice', 'probe-vm-bob')`);
db.run(`DELETE FROM releases WHERE platform IN ('darwin', 'linux')`);

const zeileFuer = (id: string) => store.listManagedUsers().find((u) => u.id === id)!;

console.log('\nFrisches Konto, noch nie gemeldet:');
let alice = zeileFuer('probe-vm-alice');
pruef('clientVersion ist null', alice.clientVersion, null);
pruef('clientPlatform ist null', alice.clientPlatform, null);
pruef('clientVersionAt ist null', alice.clientVersionAt, null);
pruef('clientVersionAktuell ist null (keine Vergleichsgrundlage)', alice.clientVersionAktuell, null);

console.log('\nAnmeldung mit appVersion schreibt den Datensatz:');
const vor = Date.now();
store.clientMeldung('probe-vm-alice', '1.0.32', 'darwin');
alice = zeileFuer('probe-vm-alice');
pruef('clientVersion steht jetzt auf 1.0.32', alice.clientVersion, '1.0.32');
pruef('clientPlatform steht auf darwin', alice.clientPlatform, 'darwin');
pruef('clientVersionAt ist gesetzt und nicht in der Vergangenheit', (alice.clientVersionAt ?? 0) >= vor, true);

console.log('\nAnmeldung OHNE appVersion (älterer Client) überschreibt einen bekannten Stand NICHT und stürzt nicht ab:');
const zeitVorLeererMeldung = alice.clientVersionAt;
store.clientMeldung('probe-vm-alice', undefined, undefined);
const aliceNachLeer = zeileFuer('probe-vm-alice');
pruef('clientVersion bleibt 1.0.32', aliceNachLeer.clientVersion, '1.0.32');
pruef('clientPlatform bleibt darwin', aliceNachLeer.clientPlatform, 'darwin');
pruef('clientVersionAt bleibt unverändert', aliceNachLeer.clientVersionAt, zeitVorLeererMeldung);

console.log('\nDasselbe für ein Konto ohne jede Vorgeschichte — keine appVersion legt nichts an:');
store.clientMeldung('probe-vm-bob', undefined, undefined);
const bobLeer = zeileFuer('probe-vm-bob');
pruef('Bobs clientVersion bleibt null', bobLeer.clientVersion, null);
pruef('Bobs clientVersionAt bleibt null', bobLeer.clientVersionAt, null);

console.log('\n"aktuell vs. veraltet" — reale Grenze über releases.istNeuer(), wie /api/releases/check:');
db.run(`INSERT INTO releases (platform, version, notes, file_name, path, size, sha256, published_by, published_at)
        VALUES ('darwin', '1.1.0', NULL, 'x', '/x', 0, 'x', 'probe-vm-alice', 0)
        ON CONFLICT(platform) DO UPDATE SET version = excluded.version`);
store.clientMeldung('probe-vm-alice', '1.0.32', 'darwin');
pruef('gemeldet 1.0.32, veröffentlicht 1.1.0 -> veraltet', zeileFuer('probe-vm-alice').clientVersionAktuell, false);
store.clientMeldung('probe-vm-alice', '1.1.0', 'darwin');
pruef('gemeldet 1.1.0, veröffentlicht 1.1.0 -> aktuell', zeileFuer('probe-vm-alice').clientVersionAktuell, true);

console.log('\nPlattform ohne veröffentlichte Fassung: keine Vergleichsgrundlage, kein Absturz:');
store.clientMeldung('probe-vm-bob', '0.9.0', 'linux');
pruef('clientVersionAktuell ist null (für linux liegt hier nichts bereit)', zeileFuer('probe-vm-bob').clientVersionAktuell, null);

console.log("\n'browser' vergleicht gegen config.version, nicht gegen die releases-Tabelle (dort gibt es keine Zeile für 'browser'):");
store.clientMeldung('probe-vm-bob', '0.0.1', 'browser');
pruef('0.0.1 gegen die laufende Serverfassung -> veraltet', zeileFuer('probe-vm-bob').clientVersionAktuell, false);
store.clientMeldung('probe-vm-bob', config.version, 'browser');
pruef('dieselbe Fassung wie der Server -> aktuell', zeileFuer('probe-vm-bob').clientVersionAktuell, true);

console.log('\nGrenzfälle der reinen Vergleichsfunktion:');
pruef('keine Plattform -> null', releases.clientAktuell(null, '1.0.0'), null);
pruef('keine Version -> null', releases.clientAktuell('darwin', null), null);

console.log('\nGeteilt sichtbar (User/SelfUser, das, was jede andere Person bzw. man selbst über sich sieht) bekommt das NICHT zu sehen — nur ManagedUser:');
const roh = db.get<any>(`SELECT * FROM users WHERE id = 'probe-vm-alice'`);
const alsUser = store.toUser(roh);
const alsSelf = store.toSelf(roh);
pruef('User trägt kein clientVersion-Feld', 'clientVersion' in alsUser, false);
pruef('User trägt kein clientPlatform-Feld', 'clientPlatform' in alsUser, false);
pruef('User trägt kein clientVersionAt-Feld', 'clientVersionAt' in alsUser, false);
pruef('User trägt kein clientVersionAktuell-Feld', 'clientVersionAktuell' in alsUser, false);
pruef('SelfUser (erbt von User) trägt ebenfalls kein clientVersion-Feld', 'clientVersion' in alsSelf, false);

console.log(fehler
  ? `\n\x1b[31m${fehler} fehlgeschlagen\x1b[0m\n`
  : '\n\x1b[32mMeldung, Überschreibschutz, Aktuell-Vergleich und Sichtbarkeitsgrenze stimmen.\x1b[0m\n');
process.exit(fehler ? 1 : 0);
