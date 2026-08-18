import type { Poll, PollOption } from '@stellium/shared';
import { db } from '../db/index.js';
import { newId } from '../util/id.js';

export function createPoll(input: {
  messageId: string; question: string; options: string[];
  multiple: boolean; anonymous: boolean; closesAt?: number | null; userId: string;
}): string {
  const clean = input.options.map((o) => o.trim()).filter(Boolean).slice(0, 12);
  if (clean.length < 2) throw new Error('Eine Umfrage braucht mindestens zwei Antwortmöglichkeiten');
  if (!input.question.trim()) throw new Error('Die Frage fehlt');

  const id = newId('pl_');
  const at = Date.now();
  db.transaction(() => {
    db.run(
      `INSERT INTO polls (id, message_id, question, multiple, anonymous, closed, closes_at, created_by, created_at)
       VALUES (?,?,?,?,?,0,?,?,?)`,
      id, input.messageId, input.question.trim(), input.multiple ? 1 : 0,
      input.anonymous ? 1 : 0, input.closesAt ?? null, input.userId, at,
    );
    clean.forEach((text, position) => {
      db.run('INSERT INTO poll_options (id, poll_id, position, text) VALUES (?,?,?,?)',
        newId('po_'), id, position, text.slice(0, 160));
    });
  });
  return id;
}

export function vote(pollId: string, userId: string, optionIds: string[]): void {
  const poll = db.get<{ multiple: number; closed: number; closes_at: number | null }>(
    'SELECT multiple, closed, closes_at FROM polls WHERE id = ?', pollId,
  );
  if (!poll) throw new Error('Umfrage nicht gefunden');
  if (poll.closed || (poll.closes_at && poll.closes_at < Date.now())) throw new Error('Diese Umfrage ist beendet');

  const valid = new Set(
    db.all<{ id: string }>('SELECT id FROM poll_options WHERE poll_id = ?', pollId).map((r) => r.id),
  );
  const chosen = optionIds.filter((id) => valid.has(id));
  if (!poll.multiple && chosen.length > 1) throw new Error('Hier ist nur eine Antwort erlaubt');

  db.transaction(() => {
    // Immer neu setzen — so ist ein Klick auf dieselbe Option ein Widerruf.
    db.run('DELETE FROM poll_votes WHERE poll_id = ? AND user_id = ?', pollId, userId);
    for (const optionId of chosen) {
      db.run('INSERT INTO poll_votes (poll_id, option_id, user_id, created_at) VALUES (?,?,?,?)',
        pollId, optionId, userId, Date.now());
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
  const optionRows = db.all<{ id: string; text: string }>(
    'SELECT id, text FROM poll_options WHERE poll_id = ? ORDER BY position', row.id,
  );
  const voteRows = db.all<{ option_id: string; user_id: string }>(
    'SELECT option_id, user_id FROM poll_votes WHERE poll_id = ?', row.id,
  );

  const byOption = new Map<string, string[]>();
  for (const v of voteRows) byOption.set(v.option_id, [...(byOption.get(v.option_id) ?? []), v.user_id]);

  const options: PollOption[] = optionRows.map((o) => {
    const voters = byOption.get(o.id) ?? [];
    return {
      id: o.id,
      text: o.text,
      // Bei anonymen Umfragen bleibt verborgen, wer gestimmt hat — nur die Zahl zählt.
      voterIds: anonymous ? [] : voters,
      votes: voters.length,
    };
  });

  return {
    id: row.id,
    messageId: row.message_id,
    question: row.question,
    options,
    multiple: Boolean(row.multiple),
    anonymous,
    closed: Boolean(row.closed) || (row.closes_at != null && row.closes_at < Date.now()),
    closesAt: row.closes_at ?? null,
    createdBy: row.created_by,
    totalVoters: new Set(voteRows.map((v) => v.user_id)).size,
    myVotes: voteRows.filter((v) => v.user_id === viewerId).map((v) => v.option_id),
  };
}
