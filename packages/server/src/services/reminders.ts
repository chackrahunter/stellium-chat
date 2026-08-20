import type { Reminder } from '@stellium/shared';
import { db } from '../db/index.js';
import { newId } from '../util/id.js';

/** Wie weit im Voraus sich etwas vormerken lässt, und wie lang die Notiz wird. */
const VORLAUF_MAX_MS = 366 * 86_400_000;
const NOTIZ_MAX = 500;
/** Wie viele offene Erinnerungen ein Konto gleichzeitig haben darf. */
const OFFEN_MAX = 200;

export function createReminder(input: {
  userId: string; channelId: string; messageId?: string | null; note?: string | null; remindAt: number;
}): Reminder {
  if (!Number.isFinite(input.remindAt)) throw new Error('Der Zeitpunkt fehlt');
  if (input.remindAt < Date.now() + 5_000) throw new Error('Der Zeitpunkt muss in der Zukunft liegen');
  /* Drei Grenzen, die alle gefehlt haben. Jede offene Erinnerung geht bei
     jeder Anmeldung mit der 'ready'-Antwort hinaus, und der Zeitgeber sieht
     sie alle fünfzehn Sekunden an. */
  if (input.remindAt > Date.now() + VORLAUF_MAX_MS) throw new Error('Weiter als ein Jahr im Voraus geht nicht');
  const offen = db.get<{ n: number }>(
    'SELECT COUNT(*) AS n FROM reminders WHERE user_id = ? AND done = 0', input.userId,
  )?.n ?? 0;
  if (offen >= OFFEN_MAX) throw new Error(`Mehr als ${OFFEN_MAX} offene Erinnerungen gehen nicht.`);

  const id = newId('rm_');
  db.run(
    'INSERT INTO reminders (id, user_id, message_id, channel_id, note, remind_at, done, created_at) VALUES (?,?,?,?,?,?,0,?)',
    id, input.userId, input.messageId ?? null, input.channelId,
    input.note?.trim().slice(0, NOTIZ_MAX) || null, input.remindAt, Date.now(),
  );
  return get(id)!;
}

export function get(id: string): Reminder | null {
  const r = db.get<any>('SELECT * FROM reminders WHERE id = ?', id);
  return r ? toReminder(r) : null;
}

export function remindersFor(userId: string): Reminder[] {
  return db.all<any>(
    'SELECT * FROM reminders WHERE user_id = ? AND done = 0 ORDER BY remind_at ASC', userId,
  ).map(toReminder);
}

export function cancel(id: string, userId: string): boolean {
  return db.run('DELETE FROM reminders WHERE id = ? AND user_id = ?', id, userId).changes > 0;
}

export function markDone(id: string, userId: string): boolean {
  return db.run('UPDATE reminders SET done = 1 WHERE id = ? AND user_id = ?', id, userId).changes > 0;
}

/**
 * Fällige Erinnerungen — wahlweise nur die von Leuten, die gerade da sind.
 *
 * Der Zeitgeber hakte bisher jede fällige Erinnerung ab und schickte sie
 * danach los. War niemand verbunden, ging sie ins Leere und stand trotzdem
 * auf erledigt: „erinnere mich morgen um neun" verschwand, wenn der Rechner
 * um neun zu war. Nachgemessen am Probeserver — nach der Rückkehr war die
 * Liste der offenen Erinnerungen leer.
 *
 * Deshalb wird jetzt nur geholt, was auch zugestellt werden kann. Das ist
 * nicht nur sparsamer, es verhindert auch, dass fünfzig liegengebliebene
 * Erinnerungen abwesender Leute das LIMIT füllen und die der Anwesenden
 * nie mehr an die Reihe kommen.
 */
export function due(now: number, userIds?: string[]) {
  if (userIds && !userIds.length) return [];
  const filter = userIds ? ` AND user_id IN (${userIds.map(() => '?').join(',')})` : '';
  return db.all<any>(
    `SELECT * FROM reminders WHERE done = 0 AND remind_at <= ?${filter} ORDER BY remind_at ASC LIMIT 50`,
    now, ...(userIds ?? []),
  ).map(toReminder);
}

function toReminder(r: any): Reminder {
  return {
    id: r.id,
    messageId: r.message_id ?? null,
    channelId: r.channel_id,
    note: r.note ?? null,
    remindAt: r.remind_at,
    done: Boolean(r.done),
    createdAt: r.created_at,
  };
}

/** "in 30 minuten", "morgen 9:00", "montag" — für den Slash-Befehl. */
export function parseWhen(input: string, now = Date.now()): number | null {
  const text = input.trim().toLowerCase();

  const rel = /^in\s+(\d+)\s*(min|minute|minuten|h|std|stunde|stunden|tag|tage|tagen)$/.exec(text);
  if (rel) {
    const n = Number(rel[1]);
    const unit = rel[2];
    if (/^min/.test(unit)) return now + n * 60_000;
    if (/^(h|std|stunde)/.test(unit)) return now + n * 3600_000;
    return now + n * 86_400_000;
  }

  const clock = /(\d{1,2})[:.](\d{2})/.exec(text);
  const hour = clock ? Number(clock[1]) : 9;
  const minute = clock ? Number(clock[2]) : 0;

  const at = new Date(now);
  if (/morgen/.test(text)) at.setDate(at.getDate() + 1);
  else if (/übermorgen/.test(text)) at.setDate(at.getDate() + 2);
  else if (/montag|dienstag|mittwoch|donnerstag|freitag|samstag|sonntag/.test(text)) {
    const days = ['sonntag', 'montag', 'dienstag', 'mittwoch', 'donnerstag', 'freitag', 'samstag'];
    const target = days.findIndex((d) => text.includes(d));
    const delta = (target - at.getDay() + 7) % 7 || 7;
    at.setDate(at.getDate() + delta);
  } else if (!clock) {
    return null;
  }

  at.setHours(hour, minute, 0, 0);
  // Nur eine Uhrzeit ohne Tag: heute, sonst morgen.
  if (at.getTime() <= now) at.setDate(at.getDate() + 1);
  return at.getTime();
}
