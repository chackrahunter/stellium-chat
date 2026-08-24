/**
 * Prüft gegen eine frische Datenbank, was eine Kontolöschung wirklich
 * anfasst — und was bewusst stehen bleibt.
 *
 * Der Befund lautete: push_subscriptions blieb stehen (der Fremdschlüssel
 * trägt ON DELETE CASCADE, aber die users-Zeile wird nur geändert, nie
 * gelöscht — die Kaskade greift nie), und praesenz_tage stand nicht in der
 * Löschliste. Für die Push-Abos ist das ein Leck: sie zeigen auf das Gerät
 * einer Person, die es nicht mehr gibt. Für die Onlinezeiten ist es eine
 * bewusste Entscheidung (siehe Kommentar über deleteAccount() in
 * services/users.ts) — dieser Lauf prüft beides.
 *
 * NACHTRAG: deleteAccount() wurde seither um vier weitere Tabellen erweitert
 * (task_watchers, hidden_messages, vertraulich_schluessel,
 * vertraulich_sicherung), während bewusst neun andere stehen bleiben. Der
 * zweite Abschnitt unten prüft beide Richtungen an einem einzigen frischen
 * Konto mit je einer Zeile in allen 13 strittigen Tabellen — assert-gone für
 * die vier neuen, assert-still-there für die neun übrigen, darunter
 * `vorschlaege` mit eigenem Kommentar direkt vor seiner Prüfung: sein
 * Dubletten-Index ist das Gedächtnis gegen genau wiederkehrende Vorschläge,
 * und das darf eine fremde Kontolöschung nicht löschen.
 *
 * Aufruf:  node scripts/konto-loeschen-pruefen.mjs
 */
import { db, initDb } from '../db/index.js';
import { deleteAccount } from '../services/users.js';

initDb();

let fehler = 0;
const pruef = (name: string, ist: unknown, soll: unknown) => {
  const ok = JSON.stringify(ist) === JSON.stringify(soll);
  if (!ok) fehler++;
  console.log(`  ${ok ? '\x1b[32m✓\x1b[0m' : '\x1b[31m✗\x1b[0m'} ${name}${ok ? '' : `  ${JSON.stringify(ist)} statt ${JSON.stringify(soll)}`}`);
};

db.run(`INSERT INTO users (id, handle, display_name, password_hash, created_at)
        VALUES ('probeU', 'probeU', 'Probe', 'x', 0)`);
db.run(`INSERT INTO push_subscriptions (id, user_id, endpoint, p256dh, auth, created_at)
        VALUES ('probeP', 'probeU', 'https://push.example/geraet', 'p', 'a', 0)`);
db.run("INSERT INTO praesenz_tage (user_id, tag, sekunden) VALUES ('probeU', '2026-08-01', 3600)");

deleteAccount('probeU');

pruef(
  'push_subscriptions der Person ist weg (kein totes Gerät bekommt noch Zustellungen)',
  db.all('SELECT 1 FROM push_subscriptions WHERE user_id = ?', 'probeU'), [],
);
pruef(
  'praesenz_tage bleibt bewusst stehen (betrieblich gebraucht, schon anonymisiert)',
  db.get<{ sekunden: number }>('SELECT sekunden FROM praesenz_tage WHERE user_id = ?', 'probeU')?.sekunden, 3600,
);
pruef(
  'das Konto selbst ist anonymisiert — praesenz_tage zeigt darüber denselben Namen',
  db.get<{ n: string }>('SELECT display_name AS n FROM users WHERE id = ?', 'probeU')?.n, 'Ehemaliges Mitglied',
);

/* ── Die 13 strittigen Tabellen: ein frisches Konto, eine Zeile überall ──
 *
 * 'probeU' oben ist schon gelöscht — deleteAccount() weist ein zweites
 * Löschen mit fehler.kontoSchonGeloescht ab (services/users.ts), ein
 * zweiter Aufruf auf dieselbe Person wäre also gar keine Prüfung, sondern
 * ein Fehlschlag an der falschen Stelle. Deshalb ein zweites, frisches
 * Konto mit den nötigen Voraussetzungen (Kanal, Aufgabe, Nachricht, Umfrage,
 * Termin, Idee) für alle 13 Tabellen auf einmal. */

console.log('\nDie 13 strittigen Tabellen — vier neu gelöscht, neun bewusst stehen bleibend:');

const U2 = 'probeU2';
db.run(`INSERT INTO users (id, handle, display_name, password_hash, created_at) VALUES (?,?,?,?,?)`, U2, U2, 'Probe2', 'x', 0);
db.run(`INSERT INTO channels (id, kind, created_by, created_at) VALUES ('probeCh2','private',?,0)`, U2);
db.run(`INSERT INTO tasks (id, title, created_by, created_at, updated_at) VALUES ('probeTask2','t',?,0,0)`, U2);
db.run(`INSERT INTO messages (id, channel_id, user_id, text, created_at) VALUES ('probeMsg2','probeCh2',?, 'hallo',0)`, U2);
db.run(`INSERT INTO polls (id, message_id, question, created_by, created_at) VALUES ('probePoll2','probeMsg2','q?',?,0)`, U2);
db.run(`INSERT INTO poll_options (id, poll_id, position, text) VALUES ('probeOpt2','probePoll2',0,'A')`);
db.run(`INSERT INTO events (id, title, starts_at, ends_at, created_by, created_at, updated_at) VALUES ('probeEvent2','e',0,1,?,0,0)`, U2);
db.run(`INSERT INTO ideas (id, title, created_by, created_at, updated_at) VALUES ('probeIdea2','i',?,0,0)`, U2);

// -- die vier NEU hinzugekommenen Tabellen --
db.run(`INSERT INTO task_watchers (task_id, user_id) VALUES ('probeTask2',?)`, U2);
db.run(`INSERT INTO hidden_messages (user_id, message_id, created_at) VALUES (?, 'probeMsg2', 0)`, U2);
db.run(`INSERT INTO vertraulich_schluessel (user_id, jwk, abdruck, erstellt_am) VALUES (?, '{}', 'fp', 0)`, U2);
db.run(`INSERT INTO vertraulich_sicherung (user_id, paket, erstellt_am) VALUES (?, 'paket', 0)`, U2);
// -- die neun, die bewusst stehen bleiben --
db.run(`INSERT INTO message_mentions (message_id, user_id) VALUES ('probeMsg2',?)`, U2);
db.run(`INSERT INTO reactions (message_id, user_id, emoji, created_at) VALUES ('probeMsg2',?, '👍', 0)`, U2);
db.run(`INSERT INTO poll_votes (poll_id, option_id, user_id, created_at) VALUES ('probePoll2','probeOpt2',?,0)`, U2);
db.run(`INSERT INTO poll_participants (poll_id, user_id, created_at) VALUES ('probePoll2',?,0)`, U2);
db.run(`INSERT INTO event_attendees (event_id, user_id, response) VALUES ('probeEvent2',?, 'yes')`, U2);
db.run(`INSERT INTO idea_votes (idea_id, user_id, wert, created_at) VALUES ('probeIdea2',?,1,0)`, U2);
db.run(`INSERT INTO idea_comments (id, idea_id, user_id, text, created_at) VALUES ('probeCmt2','probeIdea2',?, 'hi',0)`, U2);
db.run(`INSERT INTO invites (id, user_id, created_by, created_at, expires_at, used_at) VALUES ('probeInv2',?, 'admin_test', 0, 999999999999, NULL)`, U2);
/* vorschlaege: siehe der lange Kommentar unten, direkt vor seiner Prüfung. */
db.run(
  `INSERT INTO vorschlaege (id, art, zustand, titel, abdruck, channel_id, fuer_user_id, erstellt_am)
   VALUES ('probeVs2','aufgabe','abgelehnt','t','ab-probe2','probeCh2',?,0)`, U2,
);

deleteAccount(U2);

console.log('  -- assert-gone (neu hinzugekommen) --');
pruef('task_watchers ist weg (kein Versprechen an die Zukunft für ein Konto, das keine Zukunft mehr hat)',
  db.all('SELECT 1 FROM task_watchers WHERE user_id = ?', U2), []);
pruef('hidden_messages ist weg (rein private Sicht, die niemand außer dieser Person je zu sehen bekam)',
  db.all('SELECT 1 FROM hidden_messages WHERE user_id = ?', U2), []);
pruef('vertraulich_schluessel ist weg (Schlüsselmaterial für ein absichtlich nicht mehr existierendes Konto)',
  db.all('SELECT 1 FROM vertraulich_schluessel WHERE user_id = ?', U2), []);
pruef('vertraulich_sicherung ist weg (der private Teil des Schlüssels — erst recht kein Aufbewahren wert)',
  db.all('SELECT 1 FROM vertraulich_sicherung WHERE user_id = ?', U2), []);

console.log('  -- assert-still-there (bewusst stehen bleibend) --');
pruef('message_mentions bleibt stehen (Teil dessen, was eine bestehende Nachricht beim Lesen zeigt)',
  db.all('SELECT 1 FROM message_mentions WHERE user_id = ?', U2).length, 1);
pruef('reactions bleibt stehen (derselbe Grund — eine stehende Nachricht darf rückwirkend nicht anders aussehen)',
  db.all('SELECT 1 FROM reactions WHERE user_id = ?', U2).length, 1);
pruef('poll_votes bleibt stehen (protokolliertes Ergebnis einer gelaufenen, offenen Abstimmung)',
  db.all('SELECT 1 FROM poll_votes WHERE user_id = ?', U2).length, 1);
pruef('poll_participants bleibt stehen (zählt bei anonymen Umfragen in die Teilnehmerzahl)',
  db.all('SELECT 1 FROM poll_participants WHERE user_id = ?', U2).length, 1);
pruef('event_attendees bleibt stehen (Antwort auf eine Einladung — historischer Fakt wie eine Umfragestimme)',
  db.all('SELECT 1 FROM event_attendees WHERE user_id = ?', U2).length, 1);
pruef('idea_votes bleibt stehen', db.all('SELECT 1 FROM idea_votes WHERE user_id = ?', U2).length, 1);
pruef('idea_comments bleibt stehen (gelesener Inhalt, genau wie eine Nachricht)',
  db.all('SELECT 1 FROM idea_comments WHERE user_id = ?', U2).length, 1);
pruef('invites bleibt stehen (reine Beleg-Buchhaltung, ohnehin nicht mehr einlösbar)',
  db.all('SELECT 1 FROM invites WHERE user_id = ?', U2).length, 1);

/* vorschlaege verdient einen eigenen Absatz statt nur einer Zeile in der
 * Liste oben: idx_vorschlaege_dublette (UNIQUE über channel_id, art,
 * abdruck — schema.sql) ist das GESAMTE Gedächtnis gegen doppelte
 * Vorschläge, und zwar für JEDEN Zustand, auch "abgelehnt"
 * (services/vorschlaege.ts, Abschnitt "DUBLETTEN": "Sie greift auch dann,
 * wenn der Vorschlag vor Wochen abgelehnt wurde"). Der hier angelegte
 * Vorschlag steht deshalb bewusst auf zustand='abgelehnt' — genau der Fall,
 * der wie erledigter Papierkram aussieht und am ehesten versehentlich
 * mitgelöscht würde. Verschwände seine Zeile mit dem Konto der Person, für
 * die er einst galt, gäbe es beim nächsten Lauf nichts mehr, das den
 * eindeutigen Index (channel_id, art, abdruck) belegt — und genau dieselbe
 * Phrase könnte für eine ANDERE Person im selben Kanal erneut als Vorschlag
 * erscheinen, obwohl sie vor Wochen schon einmal abgelehnt wurde. Das
 * Löschen EINES Kontos würfe damit lautlos die Entscheidung einer ganz
 * anderen Person um — kein Absturz, keine Fehlermeldung, sichtbar erst
 * Wochen später und an einer Stelle, die niemand mit einer Kontolöschung in
 * Verbindung bringen würde. Genau dafür ist dieser Regressionstest da. */
pruef('vorschlaege.fuer_user_id bleibt stehen — auch ein ABGELEHNTER Vorschlag (Dubletten-Gedächtnis, idx_vorschlaege_dublette)',
  db.all('SELECT 1 FROM vorschlaege WHERE fuer_user_id = ?', U2).length, 1);

console.log(fehler ? `\n\x1b[31m${fehler} fehlgeschlagen\x1b[0m\n` : '\n\x1b[32mKontolöschung trifft Geräte und Schlüsselmaterial, lässt Betriebszahlen, gelesenen Inhalt und das Dubletten-Gedächtnis stehen.\x1b[0m\n');
process.exit(fehler ? 1 : 0);
