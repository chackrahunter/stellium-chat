import {
  TASK_PRIORITIES, TASK_STATUSES,
  type Task, type TaskEvent, type TaskPriority, type TaskStatus,
} from '@stellium/shared';
import { db, nurSichtbareKanaele } from '../db/index.js';
import { newId } from '../util/id.js';

/**
 * Aufgabenverteilung.
 *
 * Status und Priorität liegen als Schlüssel in der Datenbank ("pending",
 * "working", …) und werden erst in der Oberfläche übersetzt. Dadurch sieht
 * jede Person die Spalten in ihrer eigenen Sprache, ohne dass die Daten
 * doppelt vorliegen.
 */

/** Wie lang eine Aufgabenbeschreibung höchstens wird — beim Anlegen wie beim Ändern. */
const BESCHREIBUNG_MAX = 8000;
/** Wie lang ein Aufgabentitel höchstens wird. */
const TITEL_MAX = 300;

function toTask(r: any, watchers: string[] = []): Task {
  return {
    id: r.id,
    title: r.title,
    description: r.description ?? null,
    status: r.status as TaskStatus,
    priority: r.priority as TaskPriority,
    assigneeId: r.assignee_id ?? null,
    channelId: r.channel_id ?? null,
    messageId: r.message_id ?? null,
    dueAt: r.due_at ?? null,
    createdBy: r.created_by,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
    finishedAt: r.finished_at ?? null,
    projektId: r.projekt_id ?? null,
    vonKi: Boolean(r.von_ki),
    /* Geprüft ist alles, was ein Mensch angelegt hat — nur was die KI selbst
       eingetragen hat, wartet auf einen Blick. */
    geprueft: !r.von_ki || Boolean(r.geprueft_am),
    watcherIds: watchers,
  };
}

/** Gibt es das Projekt? Sonst null — eine fehlende Schublade darf nichts brechen. */
function projektOderNull(id: string | null | undefined): string | null {
  if (!id) return null;
  return db.get('SELECT 1 AS x FROM projekte WHERE id = ?', id) ? id : null;
}

function watchersOf(taskIds: string[]): Map<string, string[]> {
  const out = new Map<string, string[]>();
  if (!taskIds.length) return out;
  const rows = db.all<{ task_id: string; user_id: string }>(
    `SELECT task_id, user_id FROM task_watchers WHERE task_id IN (${taskIds.map(() => '?').join(',')})`,
    ...taskIds,
  );
  for (const r of rows) out.set(r.task_id, [...(out.get(r.task_id) ?? []), r.user_id]);
  return out;
}

function protokoll(taskId: string, userId: string, kind: TaskEvent['kind'],
                   von?: string | null, nach?: string | null, text?: string | null): void {
  db.run(
    'INSERT INTO task_events (id, task_id, user_id, kind, von, nach, text, created_at) VALUES (?,?,?,?,?,?,?,?)',
    newId('te_'), taskId, userId, kind, von ?? null, nach ?? null, text ?? null, Date.now(),
  );
}

/* ── Lesen ────────────────────────────────────────────────────── */

export function listTasks(filter: {
  channelId?: string | null; assigneeId?: string | null; includeFinished?: boolean;
  /**
   * Wer fragt. Ohne diese Angabe kommt alles heraus — das ist nur für
   * serverinterne Aufrufe gedacht (Aufgabenerkennung, Morgenübersicht), die
   * ohnehin schon geprüft haben, worum es geht.
   */
  sichtbarFuer?: string;
} = {}): Task[] {
  const bedingungen: string[] = [];
  const werte: any[] = [];

  /* Kanalgebundene Aufgaben nur an den Kanalkreis. Der Filter steht bewusst
     vor den anderen Bedingungen: er ist der einzige, der nicht bloß auswählt,
     sondern zurückhält. */
  if (filter.sichtbarFuer) {
    bedingungen.push(nurSichtbareKanaele());
    werte.push(filter.sichtbarFuer);
  }
  if (filter.channelId !== undefined && filter.channelId !== null) {
    bedingungen.push('channel_id = ?');
    werte.push(filter.channelId);
  }
  if (filter.assigneeId) {
    bedingungen.push('assignee_id = ?');
    werte.push(filter.assigneeId);
  }
  if (filter.includeFinished === false) {
    bedingungen.push("status <> 'finished'");
  }

  const where = bedingungen.length ? `WHERE ${bedingungen.join(' AND ')}` : '';
  const rows = db.all<any>(
    `SELECT * FROM tasks ${where}
     ORDER BY CASE status
                WHEN 'blocked' THEN 0 WHEN 'working' THEN 1 WHEN 'review' THEN 2
                WHEN 'pending' THEN 3 ELSE 4 END,
              position, created_at DESC
     LIMIT 500`,
    ...werte,
  );
  const watchers = watchersOf(rows.map((r) => r.id));
  return rows.map((r) => toTask(r, watchers.get(r.id) ?? []));
}

export function getTask(id: string): Task | null {
  const r = db.get<any>('SELECT * FROM tasks WHERE id = ?', id);
  if (!r) return null;
  return toTask(r, watchersOf([id]).get(id) ?? []);
}

export function historyOf(taskId: string): TaskEvent[] {
  return db.all<any>(
    'SELECT * FROM task_events WHERE task_id = ? ORDER BY created_at ASC LIMIT 200', taskId,
  ).map((r) => ({
    id: r.id, taskId: r.task_id, userId: r.user_id, kind: r.kind,
    von: r.von ?? null, nach: r.nach ?? null, text: r.text ?? null, createdAt: r.created_at,
  }));
}

/* ── Anlegen und ändern ───────────────────────────────────────── */

export function createTask(input: {
  title: string;
  description?: string | null;
  assigneeId?: string | null;
  channelId?: string | null;
  messageId?: string | null;
  dueAt?: number | null;
  priority?: TaskPriority;
  status?: TaskStatus;
  projektId?: string | null;
  /** Von der KI selbst eingetragen — landet dann im Reiter „Prüfen". */
  vonKi?: boolean;
  createdBy: string;
}): Task {
  // Ohne Grenze ließe sich die Datenbank mit einer einzigen Aufgabe fluten.
  const title = input.title.trim().slice(0, TITEL_MAX);
  if (title.length < 2) throw new Error('Die Aufgabe braucht einen Titel.');

  const status = input.status && TASK_STATUSES.includes(input.status) ? input.status : 'pending';
  const priority = input.priority && TASK_PRIORITIES.includes(input.priority) ? input.priority : 'normal';

  if (input.assigneeId && !db.get('SELECT 1 AS x FROM users WHERE id = ?', input.assigneeId)) {
    throw new Error('Die zugewiesene Person existiert nicht.');
  }

  const id = newId('tk_');
  const jetzt = Date.now();
  // Neue Aufgaben oben in ihrer Spalte einsortieren.
  const position = (db.get<{ min: number | null }>(
    'SELECT MIN(position) AS min FROM tasks WHERE status = ?', status,
  )?.min ?? 0) - 1;

  db.transaction(() => {
    db.run(
      `INSERT INTO tasks (id, title, description, status, priority, assignee_id, channel_id,
                          message_id, due_at, created_by, created_at, updated_at, position,
                          projekt_id, von_ki)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      id, title, input.description?.trim().slice(0, BESCHREIBUNG_MAX) || null, status, priority,
      input.assigneeId ?? null, input.channelId ?? null, input.messageId ?? null,
      input.dueAt ?? null, input.createdBy, jetzt, jetzt, position,
      /* Ein Projekt, das es nicht (mehr) gibt, wird stillschweigend zu
         „kein Projekt" — sonst scheitert das Anlegen an einer Schublade. */
      projektOderNull(input.projektId), input.vonKi ? 1 : 0,
    );
    // Wer sie anlegt und wer sie bekommt, wird automatisch benachrichtigt.
    for (const uid of new Set([input.createdBy, input.assigneeId].filter(Boolean) as string[])) {
      db.run('INSERT OR IGNORE INTO task_watchers (task_id, user_id) VALUES (?,?)', id, uid);
    }
    protokoll(id, input.createdBy, 'created', null, null, title);
    if (input.assigneeId) protokoll(id, input.createdBy, 'assignee', null, input.assigneeId);
  });

  return getTask(id)!;
}

export interface TaskPatch {
  title?: string;
  description?: string | null;
  status?: TaskStatus;
  priority?: TaskPriority;
  assigneeId?: string | null;
  dueAt?: number | null;
  channelId?: string | null;
  projektId?: string | null;
}

export function updateTask(id: string, patch: TaskPatch, userId: string): Task {
  const alt = getTask(id);
  if (!alt) throw new Error('Aufgabe nicht gefunden.');

  const sets: string[] = [];
  const werte: any[] = [];
  const notieren: (() => void)[] = [];

  if (patch.title !== undefined) {
    const titel = patch.title.trim().slice(0, TITEL_MAX);
    if (titel.length < 2) throw new Error('Die Aufgabe braucht einen Titel.');
    sets.push('title = ?'); werte.push(titel);
    notieren.push(() => protokoll(id, userId, 'title', alt.title, titel));
  }
  if (patch.description !== undefined) {
    /* Dieselbe Grenze wie in createTask(). Sie stand dort allein, und damit
       war sie wirkungslos: anlegen mit kurzem Text, ändern mit beliebig
       langem — die Aufgabe geht danach per Rundruf an das ganze Team. */
    sets.push('description = ?'); werte.push(patch.description?.trim().slice(0, BESCHREIBUNG_MAX) || null);
  }
  if (patch.status !== undefined) {
    if (!TASK_STATUSES.includes(patch.status)) throw new Error('Unbekannter Status.');
    sets.push('status = ?'); werte.push(patch.status);
    sets.push('finished_at = ?'); werte.push(patch.status === 'finished' ? Date.now() : null);
    notieren.push(() => protokoll(id, userId, 'status', alt.status, patch.status!));
  }
  if (patch.priority !== undefined) {
    if (!TASK_PRIORITIES.includes(patch.priority)) throw new Error('Unbekannte Priorität.');
    sets.push('priority = ?'); werte.push(patch.priority);
    notieren.push(() => protokoll(id, userId, 'priority', alt.priority, patch.priority!));
  }
  if (patch.assigneeId !== undefined) {
    if (patch.assigneeId && !db.get('SELECT 1 AS x FROM users WHERE id = ?', patch.assigneeId)) {
      throw new Error('Die zugewiesene Person existiert nicht.');
    }
    sets.push('assignee_id = ?'); werte.push(patch.assigneeId);
    notieren.push(() => protokoll(id, userId, 'assignee', alt.assigneeId, patch.assigneeId ?? null));
  }
  if (patch.dueAt !== undefined) {
    // Eine Fälligkeit, die keine Zahl ist, landete bisher als Zeichenkette in
    // einer INTEGER-Spalte — SQLite nimmt das an, jede Sortierung danach nicht.
    if (patch.dueAt !== null && !Number.isFinite(patch.dueAt)) throw new Error('Ungültige Fälligkeit.');
    sets.push('due_at = ?'); werte.push(patch.dueAt);
    notieren.push(() => protokoll(id, userId, 'due',
      alt.dueAt ? String(alt.dueAt) : null, patch.dueAt ? String(patch.dueAt) : null));
  }
  if (patch.channelId !== undefined) {
    sets.push('channel_id = ?'); werte.push(patch.channelId);
  }
  if (patch.projektId !== undefined) {
    sets.push('projekt_id = ?'); werte.push(projektOderNull(patch.projektId));
  }

  if (!sets.length) return alt;

  db.transaction(() => {
    db.run(`UPDATE tasks SET ${sets.join(', ')}, updated_at = ? WHERE id = ?`, ...werte, Date.now(), id);
    // Wer eine Aufgabe anfasst, verfolgt sie ab dann.
    db.run('INSERT OR IGNORE INTO task_watchers (task_id, user_id) VALUES (?,?)', id, userId);
    if (patch.assigneeId) {
      db.run('INSERT OR IGNORE INTO task_watchers (task_id, user_id) VALUES (?,?)', id, patch.assigneeId);
    }
    for (const fn of notieren) fn();
  });

  return getTask(id)!;
}

/** Neu einsortieren, z.B. beim Ziehen zwischen Spalten. */
export function reorder(id: string, status: TaskStatus, vorherId: string | null, userId: string): Task {
  const alt = getTask(id);
  if (!alt) throw new Error('Aufgabe nicht gefunden.');

  const nachbar = vorherId
    ? db.get<{ position: number }>('SELECT position FROM tasks WHERE id = ?', vorherId)?.position ?? 0
    : (db.get<{ min: number | null }>('SELECT MIN(position) AS min FROM tasks WHERE status = ?', status)?.min ?? 0) - 2;

  db.transaction(() => {
    db.run('UPDATE tasks SET status = ?, position = ?, updated_at = ?, finished_at = ? WHERE id = ?',
      status, nachbar + 1, Date.now(), status === 'finished' ? Date.now() : null, id);
    if (alt.status !== status) protokoll(id, userId, 'status', alt.status, status);
  });
  return getTask(id)!;
}

export function addComment(id: string, userId: string, text: string): TaskEvent[] {
  const sauber = text.trim();
  if (!sauber) throw new Error('Leerer Kommentar.');
  if (!getTask(id)) throw new Error('Aufgabe nicht gefunden.');
  protokoll(id, userId, 'comment', null, null, sauber.slice(0, 2000));
  db.run('INSERT OR IGNORE INTO task_watchers (task_id, user_id) VALUES (?,?)', id, userId);
  return historyOf(id);
}

export function setWatching(id: string, userId: string, watching: boolean): Task {
  if (watching) db.run('INSERT OR IGNORE INTO task_watchers (task_id, user_id) VALUES (?,?)', id, userId);
  else db.run('DELETE FROM task_watchers WHERE task_id = ? AND user_id = ?', id, userId);
  const t = getTask(id);
  if (!t) throw new Error('Aufgabe nicht gefunden.');
  return t;
}

/**
 * Was in diesem Kanal hängt — nur die Kennungen.
 *
 * Für den Fall, dass jemand den Kanal verliert: sein Brett hält die Einträge
 * als Zuordnung und räumt sie erst auf ein `*:removed` hin weg. Ohne diese
 * Liste bliebe stehen, was er gerade nicht mehr sehen darf, bis er die App
 * neu lädt — und das kann Tage dauern.
 */
export function idsImKanal(channelId: string): string[] {
  return db.all<{ id: string }>(
    'SELECT id FROM tasks WHERE channel_id = ? LIMIT 500', channelId,
  ).map((r) => r.id);
}

export function deleteTask(id: string): void {
  db.run('DELETE FROM tasks WHERE id = ?', id);
}

/** Fällige Aufgaben, für die Erinnerung am Morgen. */
export function dueSoon(userId: string, bis: number): Task[] {
  const rows = db.all<any>(
    `SELECT * FROM tasks
     WHERE assignee_id = ? AND status NOT IN ('finished') AND due_at IS NOT NULL AND due_at <= ?
     ORDER BY due_at ASC LIMIT 50`,
    userId, bis,
  );
  return rows.map((r) => toTask(r));
}

/** Kennzahlen für die Übersicht. */
export function summary(): Record<TaskStatus, number> {
  const rows = db.all<{ status: string; n: number }>('SELECT status, COUNT(*) n FROM tasks GROUP BY status');
  const out = Object.fromEntries(TASK_STATUSES.map((s) => [s, 0])) as Record<TaskStatus, number>;
  for (const r of rows) {
    if (TASK_STATUSES.includes(r.status as TaskStatus)) out[r.status as TaskStatus] = r.n;
  }
  return out;
}

/**
 * „Passt" — ein Mensch hat die KI-Aufgabe angesehen.
 *
 * Damit verlässt sie den Reiter „Prüfen" und ist eine Aufgabe wie jede
 * andere. Umgekehrt gibt es keinen Weg: eine geprüfte Aufgabe wieder auf
 * ungeprüft zu setzen hilft niemandem — wer sie loswerden will, löscht sie.
 */
export function aufgabeGeprueft(id: string): Task | null {
  const vorhanden = getTask(id);
  if (!vorhanden) return null;
  db.run('UPDATE tasks SET geprueft_am = ?, updated_at = ? WHERE id = ?', Date.now(), Date.now(), id);
  return getTask(id);
}
