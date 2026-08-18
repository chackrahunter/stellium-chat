import type { Idea, IdeaComment, IdeaStatus } from '@stellium/shared';
import { db } from '../db/index.js';
import { newId } from '../util/id.js';

/**
 * Ideenboard.
 *
 * Bewusst getrennt von den Aufgaben: eine Aufgabe hat jemanden, der sie macht,
 * eine Idee erst einmal nur jemanden, der sie hatte. Erst wenn das Team
 * zustimmt, wird daraus Arbeit — deshalb die Abstimmung und der Status.
 */

function toIdea(r: any, stimmen: Map<string, { hoch: number; runter: number; meine: number }>,
                kommentare: Map<string, number>, userId: string): Idea {
  const s = stimmen.get(r.id) ?? { hoch: 0, runter: 0, meine: 0 };
  return {
    id: r.id,
    title: r.title,
    body: r.body ?? null,
    status: r.status as IdeaStatus,
    tag: r.tag ?? '',
    channelId: r.channel_id ?? null,
    createdBy: r.created_by,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
    decidedAt: r.decided_at ?? null,
    decidedBy: r.decided_by ?? null,
    decision: r.decision ?? null,
    upvotes: s.hoch,
    downvotes: s.runter,
    myVote: s.meine as 1 | -1 | 0,
    commentCount: kommentare.get(r.id) ?? 0,
  };
}

/** Stimmen und Kommentarzahlen in einem Rutsch — sonst eine Abfrage je Idee. */
function zaehlen(ids: string[], userId: string) {
  const stimmen = new Map<string, { hoch: number; runter: number; meine: number }>();
  const kommentare = new Map<string, number>();
  if (!ids.length) return { stimmen, kommentare };

  const platzhalter = ids.map(() => '?').join(',');
  for (const r of db.all<any>(
    `SELECT idea_id, wert, user_id FROM idea_votes WHERE idea_id IN (${platzhalter})`, ...ids,
  )) {
    const e = stimmen.get(r.idea_id) ?? { hoch: 0, runter: 0, meine: 0 };
    if (r.wert > 0) e.hoch += 1; else e.runter += 1;
    if (r.user_id === userId) e.meine = r.wert;
    stimmen.set(r.idea_id, e);
  }
  for (const r of db.all<any>(
    `SELECT idea_id, COUNT(*) AS n FROM idea_comments WHERE idea_id IN (${platzhalter}) GROUP BY idea_id`, ...ids,
  )) kommentare.set(r.idea_id, r.n);

  return { stimmen, kommentare };
}

export function listIdeas(userId: string): Idea[] {
  const rows = db.all<any>('SELECT * FROM ideas ORDER BY updated_at DESC LIMIT 500');
  const { stimmen, kommentare } = zaehlen(rows.map((r) => r.id), userId);
  return rows.map((r) => toIdea(r, stimmen, kommentare, userId));
}

export function getIdea(id: string, userId: string): Idea | null {
  const row = db.get<any>('SELECT * FROM ideas WHERE id = ?', id);
  if (!row) return null;
  const { stimmen, kommentare } = zaehlen([id], userId);
  return toIdea(row, stimmen, kommentare, userId);
}

export function createIdea(input: {
  title: string; body?: string | null; tag?: string; channelId?: string | null; createdBy: string;
}): Idea {
  const titel = input.title.trim();
  if (titel.length < 3) throw new Error('Die Idee braucht einen Titel.');

  const id = newId('id_');
  const jetzt = Date.now();
  db.run(
    `INSERT INTO ideas (id, title, body, status, tag, channel_id, created_by, created_at, updated_at)
     VALUES (?,?,?,'new',?,?,?,?,?)`,
    id, titel.slice(0, 200), input.body?.trim() || null,
    (input.tag ?? '').trim().slice(0, 40), input.channelId ?? null,
    input.createdBy, jetzt, jetzt,
  );
  // Wer eine Idee einbringt, ist offensichtlich dafür.
  db.run('INSERT INTO idea_votes (idea_id, user_id, wert, created_at) VALUES (?,?,1,?)',
    id, input.createdBy, jetzt);
  return getIdea(id, input.createdBy)!;
}

export function updateIdea(id: string, patch: {
  title?: string; body?: string | null; tag?: string; channelId?: string | null;
}, userId: string): Idea {
  const idee = db.get<any>('SELECT * FROM ideas WHERE id = ?', id);
  if (!idee) throw new Error('Idee nicht gefunden.');

  const felder: string[] = [];
  const werte: any[] = [];
  if (patch.title !== undefined) {
    const t = patch.title.trim();
    if (t.length < 3) throw new Error('Die Idee braucht einen Titel.');
    felder.push('title = ?'); werte.push(t.slice(0, 200));
  }
  if (patch.body !== undefined) { felder.push('body = ?'); werte.push(patch.body?.trim() || null); }
  if (patch.tag !== undefined) { felder.push('tag = ?'); werte.push(patch.tag.trim().slice(0, 40)); }
  if (patch.channelId !== undefined) { felder.push('channel_id = ?'); werte.push(patch.channelId); }
  if (felder.length) {
    felder.push('updated_at = ?'); werte.push(Date.now());
    db.run(`UPDATE ideas SET ${felder.join(', ')} WHERE id = ?`, ...werte, id);
  }
  return getIdea(id, userId)!;
}

export function setStatus(id: string, status: IdeaStatus, userId: string, begruendung?: string | null): Idea {
  const jetzt = Date.now();
  const entschieden = status === 'done' || status === 'rejected';
  db.run(
    `UPDATE ideas SET status = ?, updated_at = ?,
            decided_at = ?, decided_by = ?, decision = ?
     WHERE id = ?`,
    status, jetzt,
    entschieden ? jetzt : null,
    entschieden ? userId : null,
    entschieden ? (begruendung?.trim() || null) : null,
    id,
  );
  const idee = getIdea(id, userId);
  if (!idee) throw new Error('Idee nicht gefunden.');
  return idee;
}

/**
 * Abstimmen. Dieselbe Stimme noch einmal nimmt sie zurück — so braucht es
 * keinen eigenen Knopf zum Entfernen.
 */
export function vote(id: string, userId: string, wert: 1 | -1): Idea {
  const vorhanden = db.get<{ wert: number }>(
    'SELECT wert FROM idea_votes WHERE idea_id = ? AND user_id = ?', id, userId,
  );
  if (vorhanden?.wert === wert) {
    db.run('DELETE FROM idea_votes WHERE idea_id = ? AND user_id = ?', id, userId);
  } else {
    db.run(
      `INSERT INTO idea_votes (idea_id, user_id, wert, created_at) VALUES (?,?,?,?)
       ON CONFLICT(idea_id, user_id) DO UPDATE SET wert = excluded.wert`,
      id, userId, wert, Date.now(),
    );
  }
  const idee = getIdea(id, userId);
  if (!idee) throw new Error('Idee nicht gefunden.');
  return idee;
}

export function comments(id: string): IdeaComment[] {
  return db.all<any>(
    'SELECT * FROM idea_comments WHERE idea_id = ? ORDER BY created_at ASC LIMIT 500', id,
  ).map((r) => ({ id: r.id, ideaId: r.idea_id, userId: r.user_id, text: r.text, createdAt: r.created_at }));
}

export function addComment(id: string, userId: string, text: string): IdeaComment[] {
  const inhalt = text.trim();
  if (!inhalt) throw new Error('Der Kommentar ist leer.');
  db.run(
    'INSERT INTO idea_comments (id, idea_id, user_id, text, created_at) VALUES (?,?,?,?,?)',
    newId('ic_'), id, userId, inhalt.slice(0, 4000), Date.now(),
  );
  db.run('UPDATE ideas SET updated_at = ? WHERE id = ?', Date.now(), id);
  return comments(id);
}

export function deleteComment(commentId: string, userId: string, darfFremde: boolean): void {
  const row = db.get<{ user_id: string }>('SELECT user_id FROM idea_comments WHERE id = ?', commentId);
  if (!row) return;
  if (row.user_id !== userId && !darfFremde) {
    throw new Error('Fremde Kommentare darf nur die Moderation löschen.');
  }
  db.run('DELETE FROM idea_comments WHERE id = ?', commentId);
}

export function deleteIdea(id: string): void {
  db.run('DELETE FROM ideas WHERE id = ?', id);
}
