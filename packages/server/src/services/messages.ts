import {
  detectLanguage, extractMentions, istE2EChiffrat, mentionsEveryone, normalizeLang,
  withinDeleteWindow, withinEditWindow, type DeleteScope, type Message,
} from '@stellium/shared';
import { db, reindexMessage, removeFromIndex } from '../db/index.js';
import { newId } from '../util/id.js';
import { dropMessageTranslations } from '../translation/index.js';
import { getMessage, getUserByHandle, hydrateMessages } from './store.js';
import { entschluesseln, verschluesseln } from '../crypto/nachrichten.js';
import { huelleLesen } from '../crypto/dateien.js';

export interface CreateMessageInput {
  channelId: string;
  userId: string;
  text: string;
  parentId?: string | null;
  attachmentIds?: string[];
  sourceLang?: string | null;
  systemKind?: string | null;
  /** "text" | "voice" | "poll" */
  kind?: string;
  /** Herkunft bei Weiterleitungen: "<messageId>|<channelId>|<userId>" */
  forwardedFrom?: string | null;
  /** Darf die Person einzelne Personen erwähnen? Sonst wird nichts eingetragen. */
  mayMention?: boolean;
  /** Darf sie den ganzen Kanal erwähnen (@alle)? */
  mayMentionEveryone?: boolean;
}

/**
 * Anhänge in einem vertraulichen Kanal müssen verschlossen sein.
 *
 * Das ist die zweite Hälfte der Zusage, die für Nachrichtentexte längst
 * gehalten wird. Bis hierher nahm der Kanal Anhänge weiter offen entgegen:
 * der Text kam als `e1:…` an, das Bild darunter lag anhörbar und ansehbar auf
 * der Platte. Wer ein Foto in einen vertraulichen Kanal legte, bekam damit
 * eine Zusage, die für seinen Anhang nicht galt.
 *
 * Geprüft wird hier und nicht in der Ereignisleitung, weil hier die einzige
 * Tür ist: senden, weiterleiten, geplant absenden, Sprachnachricht — alles
 * geht durch createMessage(). Eine Prüfung weiter außen müsste an jeder dieser
 * Stellen noch einmal stehen, und die nächste neue käme ohne sie.
 *
 * Zwei Richtungen, eine Regel: die Hülle des Anhangs muss zu dem Kanal passen,
 * in dem er landet.
 *
 *   vertraulicher Kanal, offener Anhang    → abgewiesen (der eigentliche Fall)
 *   vertraulicher Kanal, fremde Hülle      → abgewiesen; lesen könnte ihn dort
 *                                            niemand, und liegen hätte ihn ein
 *                                            Kreis, der nie gemeint war
 *   offener Kanal, verschlossener Anhang   → abgewiesen; eine private Datei aus
 *                                            der Ablage gehört nicht als
 *                                            unöffenbarer Klumpen in einen Chat
 */
function anhaengePruefen(channelId: string, attachmentIds: string[] | undefined): void {
  if (!attachmentIds?.length) return;
  const vertraulich = Boolean(db.get<{ vertraulich: number }>(
    'SELECT vertraulich FROM channels WHERE id = ?', channelId,
  )?.vertraulich);

  for (const attId of attachmentIds) {
    const zeile = db.get<{ huelle: string | null }>(
      'SELECT huelle FROM attachments WHERE id = ?', attId,
    );
    if (!zeile) continue;                     // gibt es nicht — fällt unten ohnehin weg
    const huelle = huelleLesen(zeile.huelle);

    if (!vertraulich) {
      if (huelle) {
        throw new Error(
          'Ein verschlüsselter Anhang gehört in den Kanal, für den er verschlüsselt wurde.',
        );
      }
      continue;
    }
    if (!huelle) {
      throw new Error(
        'Dieser Kanal ist vertraulich — ein Anhang muss verschlüsselt ankommen. '
        + 'Diese App kann das noch nicht; bitte aktualisieren.',
      );
    }
    if (huelle.art !== 'kanal' || huelle.channelId !== channelId) {
      throw new Error('Dieser Anhang wurde für einen anderen Kreis verschlüsselt.');
    }
  }
}

export function createMessage(input: CreateMessageInput): Message {
  const text = input.text.trim();
  if (!text && !(input.attachmentIds?.length)) throw new Error('Leere Nachricht');

  /* Ende-zu-Ende verschlüsselte Nachrichten sind länger als ihr Klartext:
     Base64 kostet ein Drittel, dazu Zähler und Prüfsumme. Dieselbe Grenze für
     beide hieße, dass in einem vertraulichen Kanal weniger Text passt als in
     einem gewöhnlichen — ausgerechnet dort, wo man es nicht erklären kann. */
  const verschlossen = istE2EChiffrat(text);
  const grenze = verschlossen ? 20_000 : 12_000;
  if (text.length > grenze) {
    /* Die beiden Zweige waren vertauscht: in einem vertraulichen Kanal wurde
       bei 20.000 Zeichen abgewiesen und dazu „max. 12.000" gemeldet. Wer die
       Nachricht kürzte, kürzte auf einen Wert, der gar nicht galt. */
    throw new Error(`Nachricht zu lang (max. ${grenze / 1000}.000 Zeichen)`);
  }

  /* Vor dem Anlegen und nicht mittendrin: eine abgewiesene Nachricht soll gar
     nicht erst entstehen, statt zurückgerollt zu werden. */
  anhaengePruefen(input.channelId, input.attachmentIds);

  const id = newId('m_');
  const at = Date.now();
  /* Bei unsicherer Erkennung lieber nichts eintragen: das Übersetzungsmodell
     erkennt die Sprache zuverlässiger und das Ergebnis wird zurückgeschrieben.

     Bei einem Chiffrat wird gar nicht erst geraten. Die Erkennung liefe über
     Base64-Zeichen und käme mit einiger Sicherheit zu einem Ergebnis — einem
     falschen, das dann als Ausgangssprache in der Datenbank stünde und die
     Nachricht in Statistiken und Filtern einer Sprache zuschlüge, mit der sie
     nichts zu tun hat. */
  const erkannt = verschlossen
    ? { lang: 'unknown', confidence: 0 }
    : input.sourceLang ? { lang: normalizeLang(input.sourceLang), confidence: 1 } : detectLanguage(text);
  const sourceLang = erkannt.lang === 'unknown' || erkannt.confidence < 0.35 ? null : erkannt.lang;

  db.transaction(() => {
    // Die Wurzel muss im selben Kanal liegen. Sonst ließe sich eine Antwort in
    // einen Thread schieben, zu dem die schreibende Person keinen Zugang hat:
    // store.threadHistory() wählt allein über parent_id aus und liefert sie
    // dort mit aus, während sie im eigenen Kanal gar nicht erst auftaucht.
    // Die Prüfung steht vor dem INSERT, damit die Zugangsentscheidung nicht am
    // Rückabwicklungspfad hängt.
    if (input.parentId) {
      const parent = db.get<{ channel_id: string }>('SELECT channel_id FROM messages WHERE id = ?', input.parentId);
      if (!parent) throw new Error('Thread-Wurzel nicht gefunden');
      if (parent.channel_id !== input.channelId) throw new Error('Thread-Wurzel gehört zu einem anderen Kanal');
    }

    db.run(
      `INSERT INTO messages (id, channel_id, user_id, parent_id, text, source_lang, system_kind, pinned, kind, forwarded_from, created_at)
       VALUES (?,?,?,?,?,?,?,0,?,?,?)`,
      id, input.channelId, input.userId, input.parentId ?? null, verschluesseln(text), sourceLang,
      input.systemKind ?? null, input.kind ?? 'text', input.forwardedFrom ?? null, at,
    );

    /* Erwähnungen nur eintragen, wenn das Recht dafür da ist. Ohne Eintrag
       gibt es keine Benachrichtigung und keine Hervorhebung.

       Aus einem Chiffrat kommt hier nichts heraus — das ist kein Mangel,
       sondern die Folge: wer erwähnt wurde, weiß nur, wer entschlüsseln kann.
       Die App der empfangenden Person erkennt die Erwähnung im Klartext und
       hebt sie hervor; der Server zählt sie nicht mit. */
    if (input.mayMention !== false && !verschlossen) {
      for (const handle of extractMentions(text)) {
        const user = getUserByHandle(handle);
        if (user) db.run('INSERT OR IGNORE INTO message_mentions (message_id, user_id) VALUES (?,?)', id, user.id);
      }
    }

    // @alle betrifft jede Person im Kanal außer der schreibenden.
    if (input.mayMentionEveryone && !verschlossen && mentionsEveryone(text)) {
      const mitglieder = db.all<{ user_id: string }>(
        'SELECT user_id FROM channel_members WHERE channel_id = ? AND user_id <> ?',
        input.channelId, input.userId,
      );
      for (const m of mitglieder) {
        db.run('INSERT OR IGNORE INTO message_mentions (message_id, user_id) VALUES (?,?)', id, m.user_id);
      }
    }

    for (const attId of input.attachmentIds ?? []) {
      db.run('UPDATE attachments SET message_id = ? WHERE id = ? AND message_id IS NULL', id, attId);
    }
  });

  reindexMessage(id);
  return getMessage(id, input.userId)!;
}

export function editMessage(messageId: string, userId: string, text: string, mayMention = true): Message {
  const row = db.get<{ user_id: string; deleted_at: number | null; created_at: number; kind: string }>(
    'SELECT user_id, deleted_at, created_at, kind FROM messages WHERE id = ?', messageId,
  );
  if (!row) throw new Error('Nachricht nicht gefunden');
  if (row.user_id !== userId) throw new Error('Nur eigene Nachrichten lassen sich bearbeiten');
  if (row.deleted_at) throw new Error('Nachricht wurde gelöscht');
  if (row.kind === 'poll') throw new Error('Umfragen lassen sich nicht nachträglich ändern.');
  // Nach dem Zeitfenster ist die Nachricht Teil des Verlaufs, auf den sich
  // andere schon bezogen haben.
  if (!withinEditWindow(row.created_at)) {
    throw new Error('Bearbeiten geht nur in den ersten zwei Stunden nach dem Senden.');
  }

  const clean = text.trim();
  if (!clean) throw new Error('Leere Nachricht');

  const verschlossen = istE2EChiffrat(clean);
  const detected = verschlossen ? 'unknown' : detectLanguage(clean).lang;
  /* Text, Erwähnungen, Übersetzungen und Volltextindex gehören zusammen und
     lagen bisher zur Hälfte außerhalb der Transaktion. Bricht es dazwischen
     ab, steht der neue Text da, während die Übersetzung noch den alten
     wiedergibt und die Suche ihn noch unter den alten Wörtern führt — beides
     sieht aus wie ein Fehler des Modells und ist keiner. */
  db.transaction(() => {
    db.run(
      'UPDATE messages SET text = ?, source_lang = ?, edited_at = ? WHERE id = ?',
      verschluesseln(clean), detected === 'unknown' ? null : detected, Date.now(), messageId,
    );
    db.run('DELETE FROM message_mentions WHERE message_id = ?', messageId);
    if (mayMention && !verschlossen) {
      for (const handle of extractMentions(clean)) {
        const user = getUserByHandle(handle);
        if (user) db.run('INSERT OR IGNORE INTO message_mentions (message_id, user_id) VALUES (?,?)', messageId, user.id);
      }
    }
    // Alte Übersetzungen passen nicht mehr zum neuen Text.
    dropMessageTranslations(messageId);
    reindexMessage(messageId);
  });
  return getMessage(messageId)!;
}

/**
 * Löschen in zwei Stufen.
 *
 *   "all"  nimmt die Nachricht für alle zurück. Erlaubt für eigene Nachrichten
 *          innerhalb des Zeitfensters, für Moderation jederzeit.
 *   "me"   blendet sie nur für die aufrufende Person aus. Immer möglich, auch
 *          bei fremden Nachrichten und nach Ablauf des Fensters.
 */
export function deleteMessage(
  messageId: string, userId: string, canDeleteAny: boolean, scope: DeleteScope = 'all',
): { channelId: string; scope: DeleteScope } {
  const row = db.get<{ user_id: string; channel_id: string; created_at: number }>(
    'SELECT user_id, channel_id, created_at FROM messages WHERE id = ?', messageId,
  );
  if (!row) throw new Error('Nachricht nicht gefunden');

  if (scope === 'me') {
    db.run('INSERT OR IGNORE INTO hidden_messages (user_id, message_id, created_at) VALUES (?,?,?)',
      userId, messageId, Date.now());
    return { channelId: row.channel_id, scope: 'me' };
  }

  const eigene = row.user_id === userId;
  if (!eigene && !canDeleteAny) throw new Error('Fremde Nachrichten darf nur die Moderation löschen.');
  if (eigene && !canDeleteAny && !withinDeleteWindow(row.created_at)) {
    throw new Error('Für alle zurücknehmen geht nur in den ersten zwei Stunden. Du kannst sie noch für dich ausblenden.');
  }

  /* Auch hier alles auf einmal: eine Nachricht, deren Text weg ist, die aber
     noch im Index steht, wäre über die Suche weiter auffindbar — und ihre
     gespeicherte Übersetzung gäbe den Inhalt wieder, den das Löschen gerade
     entfernt hat. */
  db.transaction(() => {
    db.run("UPDATE messages SET deleted_at = ?, text = '', pinned = 0 WHERE id = ?", Date.now(), messageId);
    db.run('DELETE FROM message_translations WHERE message_id = ?', messageId);
    removeFromIndex(messageId);
  });
  return { channelId: row.channel_id, scope: 'all' };
}

/** Für eine Person ausgeblendete Nachrichten. */
export function hiddenFor(userId: string, messageIds: string[]): Set<string> {
  if (!messageIds.length) return new Set();
  const rows = db.all<{ message_id: string }>(
    `SELECT message_id FROM hidden_messages WHERE user_id = ? AND message_id IN (${messageIds.map(() => '?').join(',')})`,
    userId, ...messageIds,
  );
  return new Set(rows.map((r) => r.message_id));
}

/**
 * Wie viele verschiedene Reaktionen an einer Nachricht hängen dürfen.
 *
 * Die Länge eines einzelnen Zeichens war begrenzt, ihre Anzahl nicht: eine
 * einzige Person konnte beliebig viele verschiedene daranhängen. Jede davon
 * geht danach mit jeder Auslieferung der Nachricht mit hinaus — der Verlauf
 * eines Kanals wächst also mit, ohne dass jemand etwas geschrieben hätte.
 * Fünfzig ist großzügig; auf einem Bildschirm sind zwölf schon viel.
 */
const REAKTIONSARTEN_MAX = 50;

export function toggleReaction(messageId: string, userId: string, emoji: string): { channelId: string } {
  const row = db.get<{ channel_id: string }>('SELECT channel_id FROM messages WHERE id = ?', messageId);
  if (!row) throw new Error('Nachricht nicht gefunden');

  const clean = emoji.trim().slice(0, 32);
  if (!clean) throw new Error('Emoji fehlt');

  const existing = db.get('SELECT 1 AS x FROM reactions WHERE message_id = ? AND user_id = ? AND emoji = ?', messageId, userId, clean);
  if (!existing) {
    // Zurücknehmen geht immer; nur das Hinzufügen einer *neuen* Art ist begrenzt.
    const arten = db.get<{ n: number }>(
      'SELECT COUNT(DISTINCT emoji) AS n FROM reactions WHERE message_id = ?', messageId,
    )?.n ?? 0;
    if (arten >= REAKTIONSARTEN_MAX) {
      throw new Error(`An einer Nachricht sind höchstens ${REAKTIONSARTEN_MAX} verschiedene Reaktionen möglich.`);
    }
  }
  if (existing) {
    db.run('DELETE FROM reactions WHERE message_id = ? AND user_id = ? AND emoji = ?', messageId, userId, clean);
  } else {
    db.run('INSERT INTO reactions (message_id, user_id, emoji, created_at) VALUES (?,?,?,?)', messageId, userId, clean, Date.now());
  }
  return { channelId: row.channel_id };
}

export function setPinned(messageId: string, pinned: boolean): Message | null {
  db.run('UPDATE messages SET pinned = ? WHERE id = ?', pinned ? 1 : 0, messageId);
  return getMessage(messageId);
}

export function setSaved(messageId: string, userId: string, saved: boolean): void {
  if (saved) {
    db.run('INSERT OR IGNORE INTO saved_messages (user_id, message_id, created_at) VALUES (?,?,?)', userId, messageId, Date.now());
  } else {
    db.run('DELETE FROM saved_messages WHERE user_id = ? AND message_id = ?', userId, messageId);
  }
}

export function markRead(channelId: string, userId: string, lastMessageId: string): void {
  db.run(
    `UPDATE channel_members SET last_read_message_id = ?
     WHERE channel_id = ? AND user_id = ? AND (last_read_message_id IS NULL OR last_read_message_id < ?)`,
    lastMessageId, channelId, userId, lastMessageId,
  );
}

/* ── Geplante Nachrichten ─────────────────────────────────────── */

/** Wie weit im Voraus sich eine Nachricht planen lässt. */
const PLANUNG_MAX_MS = 366 * 86_400_000;

export function scheduleMessage(input: {
  channelId: string; userId: string; text: string; sendAt: number; parentId?: string | null;
}) {
  const text = input.text.trim();
  if (!text) throw new Error('Leere Nachricht');
  if (!Number.isFinite(input.sendAt)) throw new Error('Sendezeitpunkt muss ein Zeitpunkt sein');
  if (input.sendAt < Date.now() + 10_000) throw new Error('Sendezeitpunkt muss mindestens 10 Sekunden in der Zukunft liegen');
  /* Nach oben fehlte die Grenze ganz. Eine geplante Nachricht in fünfhundert
     Jahren wäre für immer im Speicher der Sitzung und in jeder Antwort auf
     'ready' — und der Zeitgeber sähe sie nie wieder an. */
  if (input.sendAt > Date.now() + PLANUNG_MAX_MS) throw new Error('Später als ein Jahr im Voraus geht nicht');

  // Dieselbe Prüfung wie beim sofortigen Senden, nur früher: fiele sie erst
  // beim Absetzen im Ticker auf, verschwände die geplante Nachricht dort
  // kommentarlos — hier merkt es wenigstens die Person, die sie plant.
  if (input.parentId) {
    const parent = db.get<{ channel_id: string }>('SELECT channel_id FROM messages WHERE id = ?', input.parentId);
    if (!parent) throw new Error('Thread-Wurzel nicht gefunden');
    if (parent.channel_id !== input.channelId) throw new Error('Thread-Wurzel gehört zu einem anderen Kanal');
  }

  const id = newId('sc_');
  db.run(
    'INSERT INTO scheduled_messages (id, channel_id, user_id, parent_id, text, send_at, created_at) VALUES (?,?,?,?,?,?,?)',
    id, input.channelId, input.userId, input.parentId ?? null, verschluesseln(text), input.sendAt, Date.now(),
  );
  return id;
}

export function cancelScheduled(id: string, userId: string): boolean {
  const res = db.run('DELETE FROM scheduled_messages WHERE id = ? AND user_id = ?', id, userId);
  return res.changes > 0;
}

export function dueScheduled(now: number) {
  return db.all<{ id: string; channel_id: string; user_id: string; parent_id: string | null; text: string }>(
    'SELECT id, channel_id, user_id, parent_id, text FROM scheduled_messages WHERE send_at <= ? ORDER BY send_at ASC LIMIT 50',
    now,
  ).map((r) => ({ ...r, text: entschluesseln(r.text) }));
}

export function removeScheduled(id: string): void {
  db.run('DELETE FROM scheduled_messages WHERE id = ?', id);
}

export function messagesByIds(ids: string[]): Message[] {
  if (!ids.length) return [];
  const rows = db.all(`SELECT * FROM messages WHERE id IN (${ids.map(() => '?').join(',')})`, ...ids);
  return hydrateMessages(rows);
}
