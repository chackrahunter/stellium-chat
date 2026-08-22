import type { Poll, PollOption } from '@stellium/shared';
import { db } from '../db/index.js';
import { entschluesseln, verschluesseln } from '../crypto/nachrichten.js';
import { newId } from '../util/id.js';

export function createPoll(input: {
  messageId: string; question: string; options: string[];
  multiple: boolean; anonymous: boolean; closesAt?: number | null; userId: string;
}): string {
  // Länge begrenzen: eine Umfrage soll auf einen Blick lesbar sein, und ohne
  // Grenze könnte jemand die Datenbank mit einer einzigen Frage vollschreiben.
  const clean = input.options.map((o) => o.trim().slice(0, 200)).filter(Boolean).slice(0, 12);
  if (clean.length < 2) throw new Error('Eine Umfrage braucht mindestens zwei Antwortmöglichkeiten');
  const frage = input.question.trim().slice(0, 500);
  if (!frage) throw new Error('Die Frage fehlt');

  const id = newId('pl_');
  const at = Date.now();
  db.transaction(() => {
    db.run(
      `INSERT INTO polls (id, message_id, question, multiple, anonymous, closed, closes_at, created_by, created_at)
       VALUES (?,?,?,?,?,0,?,?,?)`,
      id, input.messageId, verschluesseln(frage), input.multiple ? 1 : 0,
      input.anonymous ? 1 : 0, input.closesAt ?? null, input.userId, at,
    );
    clean.forEach((text, position) => {
      db.run('INSERT INTO poll_options (id, poll_id, position, text) VALUES (?,?,?,?)',
        newId('po_'), id, position, verschluesseln(text.slice(0, 160)));
    });
  });
  return id;
}

export function vote(pollId: string, userId: string, optionIds: string[]): void {
  const poll = db.get<{ multiple: number; anonymous: number; closed: number; closes_at: number | null }>(
    'SELECT multiple, anonymous, closed, closes_at FROM polls WHERE id = ?', pollId,
  );
  if (!poll) throw new Error('Umfrage nicht gefunden');
  if (poll.closed || (poll.closes_at && poll.closes_at < Date.now())) throw new Error('Diese Umfrage ist beendet');

  const valid = new Set(
    db.all<{ id: string }>('SELECT id FROM poll_options WHERE poll_id = ?', pollId).map((r) => r.id),
  );
  // new Set(): eine doppelt genannte Option darf nicht doppelt zählen —
  // weder als zweite Zeile in poll_votes (dort verhindert das ohnehin der
  // Primärschlüssel, aber mit einem Wurf statt einer sauberen Abweisung) noch
  // als doppelter Zähler in poll_options.votes bei anonymen Umfragen, wo es
  // keine solche Bremse gibt.
  const chosen = [...new Set(optionIds.filter((id) => valid.has(id)))];
  if (!poll.multiple && chosen.length > 1) throw new Error('Hier ist nur eine Antwort erlaubt');

  if (poll.anonymous) {
    voteAnonym(pollId, userId, chosen);
    return;
  }

  db.transaction(() => {
    // Immer neu setzen — so ist ein Klick auf dieselbe Option ein Widerruf.
    db.run('DELETE FROM poll_votes WHERE poll_id = ? AND user_id = ?', pollId, userId);
    for (const optionId of chosen) {
      db.run('INSERT INTO poll_votes (poll_id, option_id, user_id, created_at) VALUES (?,?,?,?)',
        pollId, optionId, userId, Date.now());
    }
  });
}

/**
 * Abstimmen in einer ANONYMEN Umfrage.
 *
 * Bei offenen Umfragen trägt poll_votes zwei Dinge auf einmal: WER
 * abgestimmt hat und WAS. Für eine anonyme Umfrage darf das nicht in einer
 * Zeile stehen — sonst wüsste die Datenbank genau das, was die Oberfläche
 * verspricht zu verbergen. Deshalb hier zwei getrennte Schreibvorgänge:
 * poll_participants hält fest, DASS diese Person teilgenommen hat (nötig
 * gegen doppeltes Abstimmen), poll_options.votes zählt WAS gewählt wurde —
 * ohne dass irgendeine Zeile beides zugleich trägt.
 *
 * Genau das macht "Stimme ändern" unmöglich, sobald einmal abgestimmt wurde:
 * ohne die Verknüpfung weiß auch der Server nicht mehr, welche Zähler er bei
 * einer Änderung wieder herunterzählen müsste. Eine Änderung zuzulassen hieße
 * entweder, die Verknüpfung doch zu speichern (und damit die Zusage zu
 * brechen), oder blind zu raten, welcher Zähler sinkt (und damit die Zählung
 * zu verfälschen). Die einzig ehrliche Lösung ist, die erste Stimme gelten zu
 * lassen und jede weitere abzuweisen — bei einer geheimen Wahl im
 * Vereinssaal ist das nicht anders.
 */
function voteAnonym(pollId: string, userId: string, chosen: string[]): void {
  if (!chosen.length) return;   // nichts ausgewählt — keine Teilnahme einzutragen

  const schonDabei = db.get('SELECT 1 AS x FROM poll_participants WHERE poll_id = ? AND user_id = ?', pollId, userId);
  if (schonDabei) {
    throw new Error('Du hast bei dieser anonymen Umfrage schon abgestimmt — das lässt sich danach nicht mehr ändern.');
  }

  db.transaction(() => {
    db.run('INSERT INTO poll_participants (poll_id, user_id, created_at) VALUES (?,?,?)', pollId, userId, Date.now());
    for (const optionId of chosen) {
      db.run('UPDATE poll_options SET votes = votes + 1 WHERE id = ?', optionId);
    }
  });
}

export function closePoll(pollId: string, userId: string, isAdmin: boolean): void {
  const poll = db.get<{ created_by: string }>('SELECT created_by FROM polls WHERE id = ?', pollId);
  if (!poll) throw new Error('Umfrage nicht gefunden');
  if (poll.created_by !== userId && !isAdmin) throw new Error('Nur wer die Umfrage gestartet hat, kann sie beenden');
  db.run('UPDATE polls SET closed = 1 WHERE id = ?', pollId);
}

export function pollForMessage(messageId: string, viewerId: string): Poll | null {
  const row = db.get<any>('SELECT * FROM polls WHERE message_id = ?', messageId);
  return row ? hydrate(row, viewerId) : null;
}

export function getPoll(pollId: string, viewerId: string): Poll | null {
  const row = db.get<any>('SELECT * FROM polls WHERE id = ?', pollId);
  return row ? hydrate(row, viewerId) : null;
}

function hydrate(row: any, viewerId: string): Poll {
  const anonymous = Boolean(row.anonymous);
  const basis = {
    id: row.id as string,
    messageId: row.message_id as string,
    question: entschluesseln(row.question),
    multiple: Boolean(row.multiple),
    anonymous,
    closed: Boolean(row.closed) || (row.closes_at != null && row.closes_at < Date.now()),
    closesAt: (row.closes_at ?? null) as number | null,
    createdBy: row.created_by as string,
  };

  // votes steht bei offenen Umfragen zwar mit in der Zeile, bleibt dort aber
  // auf 0 und ungenutzt — für sie zählt weiter poll_votes (siehe schema.sql).
  const optionRows = db.all<{ id: string; text: string; votes: number }>(
    'SELECT id, text, votes FROM poll_options WHERE poll_id = ? ORDER BY position', row.id,
  );

  if (anonymous) {
    /* Weder hier noch sonst irgendwo lässt sich ablesen, WAS diese Person
       gewählt hat — das steht nirgends in der Datenbank (siehe voteAnonym).
       hasVoted ist die einzige Auskunft, die es dazu gibt: DASS abgestimmt
       wurde. Die Oberfläche sperrt die Auswahl dann, ohne eine bestimmte
       Antwort hervorzuheben — sie kennt die eigene Wahl selbst nicht mehr,
       sobald die Antwort dieses Aufrufs verarbeitet ist. */
    const hatTeilgenommen = Boolean(
      db.get('SELECT 1 AS x FROM poll_participants WHERE poll_id = ? AND user_id = ?', row.id, viewerId),
    );
    const gesamt = db.get<{ n: number }>(
      'SELECT COUNT(*) AS n FROM poll_participants WHERE poll_id = ?', row.id,
    )?.n ?? 0;
    const options: PollOption[] = optionRows.map((o) => ({
      id: o.id, text: entschluesseln(o.text), voterIds: [], votes: o.votes,
    }));
    return { ...basis, options, totalVoters: gesamt, myVotes: [], hasVoted: hatTeilgenommen };
  }

  const voteRows = db.all<{ option_id: string; user_id: string }>(
    'SELECT option_id, user_id FROM poll_votes WHERE poll_id = ?', row.id,
  );
  const byOption = new Map<string, string[]>();
  for (const v of voteRows) byOption.set(v.option_id, [...(byOption.get(v.option_id) ?? []), v.user_id]);
  const options: PollOption[] = optionRows.map((o) => {
    const voters = byOption.get(o.id) ?? [];
    return { id: o.id, text: entschluesseln(o.text), voterIds: voters, votes: voters.length };
  });
  const myVotes = voteRows.filter((v) => v.user_id === viewerId).map((v) => v.option_id);

  return {
    ...basis, options,
    totalVoters: new Set(voteRows.map((v) => v.user_id)).size,
    myVotes,
    hasVoted: myVotes.length > 0,
  };
}
