/**
 * Prüft gegen eine frische Datenbank: hält das Versprechen "anonym" wirklich
 * bis in die Datenbank hinein?
 *
 * Der Datenschutz-Befund lautete: `polls.anonymous` war nur ein
 * Anzeigemerkmal, die Zuordnung Person→Antwort stand trotzdem in
 * `poll_votes`. Dieser Lauf legt eine anonyme Umfrage an, lässt zwei Konten
 * abstimmen, und sieht dann in der ROHEN Datenbank nach — nicht über
 * getPoll(), das könnte selbst beschönigen, sondern mit eigenem SQL gegen
 * dieselben Tabellen, die auch ein Betreiber mit Dateizugriff sähe.
 *
 * Zur Gegenprobe läuft dieselbe Prüfung ein zweites Mal für eine OFFENE
 * Umfrage — dort MUSS die Zuordnung weiter in poll_votes stehen, sonst wären
 * "Stimme ändern" und die Gesichter unter den Antworten kaputt.
 *
 * Aufruf:  node scripts/umfrage-anonym-pruefen.mjs
 */
import { db, initDb } from '../db/index.js';
import * as polls from '../services/polls.js';

initDb();

let fehler = 0;
const pruef = (name: string, ist: unknown, soll: unknown) => {
  const ok = JSON.stringify(ist) === JSON.stringify(soll);
  if (!ok) fehler++;
  console.log(`  ${ok ? '\x1b[32m✓\x1b[0m' : '\x1b[31m✗\x1b[0m'} ${name}${ok ? '' : `  ${JSON.stringify(ist)} statt ${JSON.stringify(soll)}`}`);
};

function person(id: string): void {
  db.run(
    `INSERT OR IGNORE INTO users (id, handle, display_name, password_hash, created_at)
     VALUES (?,?,?,'x',0)`, id, id, id,
  );
}
person('probe1');
person('probe2');

db.run(`INSERT OR IGNORE INTO channels (id, kind, name, created_by, created_at)
        VALUES ('probe-ch', 'public', 'probe', 'probe1', 0)`);

function nachricht(id: string): void {
  db.run(
    `INSERT OR IGNORE INTO messages (id, channel_id, user_id, text, kind, created_at)
     VALUES (?, 'probe-ch', 'probe1', 'Umfrage', 'poll', 0)`, id,
  );
}

/* ── Anonyme Umfrage ──────────────────────────────────────────── */
nachricht('probe-msg-anon');
const anonId = polls.createPoll({
  messageId: 'probe-msg-anon', question: 'Sieht die App gut aus?',
  options: ['Ja', 'Nein'], multiple: false, anonymous: true, userId: 'probe1',
});
const anonOptions = db.all<{ id: string }>('SELECT id FROM poll_options WHERE poll_id = ? ORDER BY position', anonId);

polls.vote(anonId, 'probe1', [anonOptions[0].id]);
polls.vote(anonId, 'probe2', [anonOptions[0].id]);

console.log('\nAnonyme Umfrage — rohe Datenbank:');
const anonVoteRows = db.all('SELECT * FROM poll_votes WHERE poll_id = ?', anonId);
pruef('poll_votes trägt KEINE Zeile zu dieser Umfrage', anonVoteRows, []);

const anonTeilnehmer = db.all<{ user_id: string }>(
  'SELECT user_id FROM poll_participants WHERE poll_id = ? ORDER BY user_id', anonId,
).map((r) => r.user_id);
pruef('poll_participants trägt WER (ohne Antwort)', anonTeilnehmer, ['probe1', 'probe2']);

const anonCount = db.get<{ votes: number }>('SELECT votes FROM poll_options WHERE id = ?', anonOptions[0].id)?.votes;
pruef('Zählung stimmt trotzdem: 2 Stimmen für die erste Antwort', anonCount, 2);

const gehydratet = polls.getPoll(anonId, 'probe1')!;
pruef('hasVoted ist wahr', gehydratet.hasVoted, true);
pruef('myVotes bleibt leer — auch für die eigene Stimme', gehydratet.myVotes, []);
pruef('voterIds bleibt für jede Antwort leer', gehydratet.options.map((o) => o.voterIds), [[], []]);
pruef('totalVoters zählt über poll_participants', gehydratet.totalVoters, 2);

let zweiteStimmeAbgewiesen = false;
try {
  polls.vote(anonId, 'probe1', [anonOptions[1].id]);
} catch {
  zweiteStimmeAbgewiesen = true;
}
pruef('eine zweite, andere Stimme derselben Person wird abgewiesen', zweiteStimmeAbgewiesen, true);

/* ── Gegenprobe: offene Umfrage behält die Zuordnung ─────────── */
nachricht('probe-msg-offen');
const offenId = polls.createPoll({
  messageId: 'probe-msg-offen', question: 'Testfrage offen',
  options: ['Ja', 'Nein'], multiple: false, anonymous: false, userId: 'probe1',
});
const offenOptions = db.all<{ id: string }>('SELECT id FROM poll_options WHERE poll_id = ? ORDER BY position', offenId);
polls.vote(offenId, 'probe1', [offenOptions[0].id]);

console.log('\nOffene Umfrage — Gegenprobe:');
const offenVoteRows = db.all<{ user_id: string; option_id: string }>(
  'SELECT user_id, option_id FROM poll_votes WHERE poll_id = ?', offenId,
);
pruef('poll_votes trägt hier weiterhin Person UND Antwort', offenVoteRows, [{ user_id: 'probe1', option_id: offenOptions[0].id }]);

console.log(fehler
  ? `\n\x1b[31m${fehler} fehlgeschlagen\x1b[0m\n`
  : '\n\x1b[32mAnonym heißt hier wirklich anonym — auch in der Datenbank.\x1b[0m\n');
process.exit(fehler ? 1 : 0);
