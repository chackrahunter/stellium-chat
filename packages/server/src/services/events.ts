import { EVENT_KINDS, type AttendeeResponse, type CalendarEvent, type EventKind } from '@stellium/shared';
import { db } from '../db/index.js';
import { newId } from '../util/id.js';

/**
 * Team-Kalender.
 *
 * Alle Zeitpunkte liegen als UTC-Millisekunden in der Datenbank. Die Umrechnung
 * in die Ortszeit macht die Oberfläche — bei einem Team über mehrere Zeitzonen
 * ist das der einzige Weg, der für alle stimmt.
 */

function toEvent(r: any, teilnehmende: { userId: string; response: AttendeeResponse }[] = []): CalendarEvent {
  return {
    id: r.id,
    title: r.title,
    description: r.description ?? null,
    kind: r.kind as EventKind,
    startsAt: r.starts_at,
    endsAt: r.ends_at,
    allDay: Boolean(r.all_day),
    location: r.location ?? null,
    channelId: r.channel_id ?? null,
    createdBy: r.created_by,
    createdAt: r.created_at,
    attendees: teilnehmende,
  };
}

function attendeesOf(eventIds: string[]): Map<string, { userId: string; response: AttendeeResponse }[]> {
  const out = new Map<string, { userId: string; response: AttendeeResponse }[]>();
  if (!eventIds.length) return out;
  const rows = db.all<{ event_id: string; user_id: string; response: string }>(
    `SELECT event_id, user_id, response FROM event_attendees WHERE event_id IN (${eventIds.map(() => '?').join(',')})`,
    ...eventIds,
  );
  for (const r of rows) {
    out.set(r.event_id, [...(out.get(r.event_id) ?? []),
      { userId: r.user_id, response: r.response as AttendeeResponse }]);
  }
  return out;
}

/** Termine, die sich mit dem Zeitraum überschneiden. */
export function listEvents(from: number, to: number): CalendarEvent[] {
  const rows = db.all<any>(
    'SELECT * FROM events WHERE starts_at < ? AND ends_at > ? ORDER BY starts_at ASC LIMIT 500',
    to, from,
  );
  const teilnehmende = attendeesOf(rows.map((r) => r.id));
  return rows.map((r) => toEvent(r, teilnehmende.get(r.id) ?? []));
}

export function getEvent(id: string): CalendarEvent | null {
  const r = db.get<any>('SELECT * FROM events WHERE id = ?', id);
  return r ? toEvent(r, attendeesOf([id]).get(id) ?? []) : null;
}

export function createEvent(input: {
  title: string; description?: string | null; kind?: string;
  startsAt: number; endsAt: number; allDay?: boolean;
  location?: string | null; channelId?: string | null;
  attendeeIds?: string[]; createdBy: string;
}): CalendarEvent {
  const title = input.title.trim();
  if (title.length < 2) throw new Error('Der Termin braucht einen Titel.');
  if (input.endsAt <= input.startsAt) throw new Error('Das Ende muss nach dem Beginn liegen.');
  if (input.endsAt - input.startsAt > 366 * 86_400_000) throw new Error('Ein Termin darf höchstens ein Jahr dauern.');

  const kind = (EVENT_KINDS as string[]).includes(input.kind ?? '') ? input.kind! : 'meeting';
  const id = newId('ev_');
  const jetzt = Date.now();

  db.transaction(() => {
    db.run(
      `INSERT INTO events (id, title, description, kind, starts_at, ends_at, all_day,
                           location, channel_id, created_by, created_at, updated_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,
      id, title, input.description?.trim() || null, kind,
      input.startsAt, input.endsAt, input.allDay ? 1 : 0,
      input.location?.trim() || null, input.channelId ?? null,
      input.createdBy, jetzt, jetzt,
    );
    // Wer einlädt, ist selbst dabei — und hat automatisch zugesagt.
    db.run('INSERT OR IGNORE INTO event_attendees (event_id, user_id, response) VALUES (?,?,?)',
      id, input.createdBy, 'yes');
    for (const uid of input.attendeeIds ?? []) {
      if (uid === input.createdBy) continue;
      if (!db.get('SELECT 1 AS x FROM users WHERE id = ?', uid)) continue;
      db.run('INSERT OR IGNORE INTO event_attendees (event_id, user_id, response) VALUES (?,?,?)',
        id, uid, 'pending');
    }
  });
  return getEvent(id)!;
}

export function updateEvent(id: string, patch: {
  title?: string; description?: string | null; startsAt?: number; endsAt?: number;
  allDay?: boolean; location?: string | null; kind?: string;
}): CalendarEvent {
  const alt = getEvent(id);
  if (!alt) throw new Error('Termin nicht gefunden.');

  const beginn = patch.startsAt ?? alt.startsAt;
  const ende = patch.endsAt ?? alt.endsAt;
  if (ende <= beginn) throw new Error('Das Ende muss nach dem Beginn liegen.');

  const sets: string[] = [];
  const werte: any[] = [];
  if (patch.title !== undefined) {
    if (patch.title.trim().length < 2) throw new Error('Der Termin braucht einen Titel.');
    sets.push('title = ?'); werte.push(patch.title.trim());
  }
  if (patch.description !== undefined) { sets.push('description = ?'); werte.push(patch.description?.trim() || null); }
  if (patch.startsAt !== undefined) { sets.push('starts_at = ?'); werte.push(patch.startsAt); }
  if (patch.endsAt !== undefined) { sets.push('ends_at = ?'); werte.push(patch.endsAt); }
  if (patch.allDay !== undefined) { sets.push('all_day = ?'); werte.push(patch.allDay ? 1 : 0); }
  if (patch.location !== undefined) { sets.push('location = ?'); werte.push(patch.location?.trim() || null); }
  if (patch.kind !== undefined && (EVENT_KINDS as string[]).includes(patch.kind)) {
    sets.push('kind = ?'); werte.push(patch.kind);
  }
  if (!sets.length) return alt;

  db.run(`UPDATE events SET ${sets.join(', ')}, updated_at = ? WHERE id = ?`, ...werte, Date.now(), id);
  return getEvent(id)!;
}

export function respond(eventId: string, userId: string, response: AttendeeResponse): CalendarEvent {
  if (!getEvent(eventId)) throw new Error('Termin nicht gefunden.');
  db.run(
    `INSERT INTO event_attendees (event_id, user_id, response) VALUES (?,?,?)
     ON CONFLICT(event_id, user_id) DO UPDATE SET response = excluded.response`,
    eventId, userId, response,
  );
  return getEvent(eventId)!;
}

export function setAttendees(eventId: string, add: string[] = [], remove: string[] = []): CalendarEvent {
  const ev = getEvent(eventId);
  if (!ev) throw new Error('Termin nicht gefunden.');
  db.transaction(() => {
    for (const uid of add) {
      if (!db.get('SELECT 1 AS x FROM users WHERE id = ?', uid)) continue;
      db.run('INSERT OR IGNORE INTO event_attendees (event_id, user_id, response) VALUES (?,?,?)',
        eventId, uid, 'pending');
    }
    for (const uid of remove) {
      if (uid === ev.createdBy) continue;   // wer einlädt, bleibt dabei
      db.run('DELETE FROM event_attendees WHERE event_id = ? AND user_id = ?', eventId, uid);
    }
  });
  return getEvent(eventId)!;
}

export function deleteEvent(id: string): void {
  db.run('DELETE FROM events WHERE id = ?', id);
}

/** Wer ist wann abwesend? Für die Übersicht im Kalender. */
export function absences(from: number, to: number): CalendarEvent[] {
  return listEvents(from, to).filter((e) => e.kind === 'absence' || e.kind === 'holiday');
}

/** Termine, die bald beginnen — für die Erinnerung. */
export function startingSoon(innerhalbMs: number): CalendarEvent[] {
  const jetzt = Date.now();
  const rows = db.all<any>(
    'SELECT * FROM events WHERE starts_at BETWEEN ? AND ? AND all_day = 0 ORDER BY starts_at ASC LIMIT 50',
    jetzt, jetzt + innerhalbMs,
  );
  const teilnehmende = attendeesOf(rows.map((r) => r.id));
  return rows.map((r) => toEvent(r, teilnehmende.get(r.id) ?? []));
}
