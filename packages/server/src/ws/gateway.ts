import type { WebSocket } from 'ws';
import { kennungVon } from '../util/abweisung.js';
import {
  decode, encode, isSupportedLang, normalizeLang, WS_PROTOCOL_VERSION,
  type ClientEvent, type Message, type ServerEvent, type Task, type UserStatus,
  type Vorschlag,
} from '@stellium/shared';
import { verifyToken } from '../auth.js';
import { db } from '../db/index.js';
import { config } from '../config.js';
import { newId } from '../util/id.js';
import { aiCapabilities, roundTrip, translate, translateMessage, translatePoll, translateChannel } from '../translation/index.js';
import * as ai from '../services/ai.js';
import * as channels from '../services/channels.js';
import * as messages from '../services/messages.js';
import * as store from '../services/store.js';
import { grenze } from '../services/search.js';
import * as polls from '../services/polls.js';
import { may } from '../services/users.js';
import { extractMentions, mentionsEveryone, PERMISSIONS, type PermissionKey } from '@stellium/shared';
import * as reminders from '../services/reminders.js';
import * as drafts from '../services/drafts.js';
import { attachPreviews, extractUrls } from '../services/links.js';
import { saveTranscript, transcribe, voiceNoteFor } from '../services/voice.js';
import * as ki from '../services/assistant.js';
import * as tasks from '../services/tasks.js';
import * as settings from '../services/settings.js';
import * as releases from '../services/releases.js';
import { entschluesseln, verschluesseln } from '../crypto/nachrichten.js';
import * as vertraulich from '../services/vertraulich.js';
import { istE2EChiffrat } from '@stellium/shared';
import * as events from '../services/events.js';
import * as files from '../services/files.js';
import * as ideas from '../services/ideas.js';
import * as vorschlaege from '../services/vorschlaege.js';
import * as wartung from '../services/wartung.js';
import { db as database } from '../db/index.js';
import { reindexMessage } from '../db/index.js';

interface Session {
  id: string;
  socket: WebSocket;
  userId: string | null;
  language: string;
  autoTranslate: boolean;
  openChannelId: string | null;
  alive: boolean;
}

const sessions = new Map<string, Session>();
const byUser = new Map<string, Set<Session>>();
/** Verhindert doppelte Übersetzungsaufträge für dieselbe Nachricht+Sprache. */
const inflight = new Map<string, Promise<unknown>>();

function send(session: Session, ev: ServerEvent): void {
  if (session.socket.readyState !== 1) return;
  try { session.socket.send(encode(ev)); } catch { /* Socket ist weg */ }
}

function sendToUser(userId: string, ev: ServerEvent): void {
  for (const s of byUser.get(userId) ?? []) send(s, ev);
}

/** Für Ereignisse, die außerhalb des Gateways entstehen (z. B. HTTP-Uploads). */
export function broadcastAll(ev: ServerEvent): void {
  broadcast(ev);
}

/**
 * Darf diese Person die Nachricht überhaupt sehen?
 *
 * Mehrere Ereignisse nehmen eine Nachrichtenkennung entgegen und antworten mit
 * deren Inhalt — übersetzen, Thread öffnen, merken. Ohne diese Prüfung genügte
 * eine bekannte Kennung, um an Nachrichten aus fremden Kanälen und
 * Direktchats zu kommen. Kennungen sind zufällig, aber sie wandern: durch
 * Weiterleitungen, Zitate, Protokolle.
 *
 * Die Arbeitsteilung mit darfNachrichtAendern() ist bewusst so: lesen und
 * alles, was an der eigenen Person hängt — merken, anheften, abstimmen —
 * verlangt Mitgliedschaft; einwirken auf den Nachrichtenkörper geht auch für
 * stille Mitleser:innen offener Kanäle.
 */
function darfNachrichtSehen(userId: string, messageId: string): boolean {
  const msg = database.get<{ channel_id: string }>(
    'SELECT channel_id FROM messages WHERE id = ?', messageId,
  );
  if (!msg) return false;
  return store.memberIds(msg.channel_id).includes(userId);
}

/**
 * Darf diese Person auf die Nachricht einwirken — reagieren, löschen?
 *
 * Wie darfNachrichtSehen(), nur zählen offene Kanäle mit: dort liest jede
 * Person mit, ohne beigetreten zu sein, und Mitglied wird man erst mit dem
 * ersten eigenen Beitrag. Eine strenge Mitgliedsprüfung sperrte hier also
 * stille Mitleser:innen aus. In privaten Kanälen und Direktchats bleibt es
 * bei der Mitgliedschaft — sonst genügte eine bekannte Kennung, um dort
 * Nachrichten verschwinden zu lassen oder Reaktionen zu hinterlassen.
 *
 * Bekannte Einschränkung: der Rundruf danach geht an store.memberIds(), also
 * gerade nicht an die stillen Mitleser:innen. Sie dürfen reagieren, sehen ihre
 * eigene Reaktion aber erst, wenn sie den Kanal neu öffnen.
 */
function darfNachrichtAendern(userId: string, messageId: string): boolean {
  return darfNachrichtLesen(userId, messageId);
}

/**
 * Darf diese Person in diesen Kanal hineinsehen?
 *
 * Nicht zu verwechseln mit store.getChannel(): das beantwortet eine andere
 * Frage, nämlich ob es den Kanal überhaupt gibt. Genau diese Verwechslung war
 * hier der teuerste Fund des Durchgangs — fünf Stellen prüften mit
 * `if (!store.getChannel(id, userId))`, und der Kommentar daneben behauptete
 * „also nur, wo man mitliest". In Wahrheit genügte die Kennung eines fremden
 * privaten Kanals, um sich seinen Inhalt zusammenfassen, protokollieren oder
 * beantworten zu lassen.
 *
 * Die Regel ist dieselbe wie bei darfNachrichtLesen(): offene Kanäle stehen
 * jedem offen, auch ohne Beitritt; alles andere verlangt Mitgliedschaft.
 */
function darfKanalSehen(userId: string, channelId: string | null | undefined): boolean {
  if (!channelId) return false;
  const ch = database.get<{ kind: string }>('SELECT kind FROM channels WHERE id = ?', channelId);
  if (!ch) return false;
  return ch.kind === 'public' || store.isMember(channelId, userId);
}

/** Dasselbe mit Abweisung — spart die Zeile an jeder einzelnen Stelle. */
function kanalZugang(session: Session, channelId: string | null | undefined, requestId?: string): boolean {
  if (darfKanalSehen(session.userId!, channelId)) return true;
  fail(session, 'fehler.keinKanalZugriff', 'Kein Zugriff auf diesen Kanal', requestId);
  return false;
}

/**
 * Wer ein Element sehen darf, das an einem Kanal hängen kann.
 *
 * `undefined` heißt „alle" — genau das, was broadcast() ohne Empfängerkreis
 * tut. Aufgaben, Termine und Ideen ohne Kanal gehen das ganze Team an und
 * bleiben für alle sichtbar; was an einem Kanal hängt, geht nur an dessen
 * Kreis. Offene Kanäle darf jeder sehen, also auch hier: alle.
 *
 * Gibt es den Kanal nicht mehr, ist die Bindung fort und das Element wieder
 * für alle da. Über die Fremdschlüssel (ON DELETE SET NULL) kann das gar
 * nicht eintreten — die Zeile trägt dann NULL —, aber die Antwort soll
 * dieselbe sein wie in dem Fall, den es wirklich gibt.
 */
function empfaengerFuer(channelId: string | null | undefined): string[] | undefined {
  if (!channelId) return undefined;
  const ch = database.get<{ kind: string }>('SELECT kind FROM channels WHERE id = ?', channelId);
  if (!ch || ch.kind === 'public') return undefined;
  return store.memberIds(channelId);
}

/**
 * Darf diese Person das Element sehen?
 *
 * Bewusst aus empfaengerFuer() abgeleitet und nicht daneben noch einmal
 * formuliert: sonst gäbe es zwei Regeln, die dasselbe entscheiden sollen, und
 * eines Tages entscheiden sie es verschieden. Die Liste ist der Rundruf, die
 * Prüfung ist die Einzelabfrage — dieselbe Antwort, zwei Verwendungen.
 */
function darfElementSehen(userId: string, channelId: string | null | undefined): boolean {
  const kreis = empfaengerFuer(channelId);
  return kreis === undefined || kreis.includes(userId);
}

/**
 * Wer ein Element nach einem Umzug nicht mehr sehen darf.
 *
 * Zieht eine Aufgabe in einen privaten Kanal (oder eine Idee), verschwindet
 * sie für alle anderen — aber nur, wenn man es ihnen sagt. Der Client hält
 * seine Bretter als Zuordnung und räumt einen Eintrag erst auf ein
 * `*:removed` hin weg; ohne diese Meldung bliebe die Aufgabe dort stehen,
 * bis jemand die Liste neu lädt. Sichtbar wäre sie dann für Leute, die sie
 * gerade verloren haben.
 */
function verlorenGegangen(vorher: string[] | undefined, nachher: string[] | undefined): string[] {
  if (nachher === undefined) return [];                    // jetzt sehen es alle
  const jetzt = new Set(nachher);
  // `undefined` vorher heißt: es sahen alle. Stale Zustand kann nur haben,
  // wer gerade verbunden ist.
  const vorherige = vorher ?? [...byUser.keys()];
  return vorherige.filter((uid) => !jetzt.has(uid));
}

/**
 * Was aus einem Kanal stammt, von den Brettern derer nehmen, die ihn gerade
 * verloren haben.
 *
 * Aufgaben, Termine und Ideen bleiben bestehen, wenn jemand einen Kanal
 * verlässt — sie gehören dem Kanal, nicht ihm. Auf seinem Schirm stehen sie
 * trotzdem weiter, denn der Client räumt einen Eintrag erst auf ein
 * `*:removed` hin weg. Wer eine App über Nacht offen lässt, säße also am
 * nächsten Morgen noch vor den Aufgabentiteln eines Kanals, aus dem er
 * gestern entfernt wurde.
 */
function kanalElementeZuruecknehmen(channelId: string, userIds: string[]): void {
  if (!userIds.length) return;
  // Bei einem offenen Kanal — oder wenn es ihn nicht mehr gibt — ist nichts
  // zurückzunehmen: dann darf es ohnehin jeder sehen.
  if (empfaengerFuer(channelId) === undefined) return;
  const aufgaben = tasks.idsImKanal(channelId);
  const termine = events.idsImKanal(channelId);
  const ideen = ideas.idsImKanal(channelId);
  const vorschlaegeImKanal = vorschlaege.idsImKanal(channelId);
  for (const uid of userIds) {
    if (store.isMember(channelId, uid)) continue;      // doch noch dabei
    for (const id of aufgaben) sendToUser(uid, { t: 'task:removed', taskId: id });
    for (const id of termine) sendToUser(uid, { t: 'event:removed', eventId: id });
    for (const id of ideen) sendToUser(uid, { t: 'idea:removed', ideaId: id });
    /* Vorschläge gehören genau einer Person, aber dieselbe Überlegung gilt:
       wer den Kanal verliert, darf dessen Vorschläge nicht weiter im Eingang
       stehen haben — in ihren Titeln steht, worüber dort geredet wurde. */
    for (const id of vorschlaegeImKanal) sendToUser(uid, { t: 'vorschlag:removed', vorschlagId: id });
  }
}

/** Der Kanal einer Nachricht — und ob man ihn sehen darf. */
function darfNachrichtLesen(userId: string, messageId: string): boolean {
  const row = database.get<{ channel_id: string }>(
    'SELECT channel_id FROM messages WHERE id = ?', messageId,
  );
  return Boolean(row) && darfKanalSehen(userId, row!.channel_id);
}

function broadcast(ev: ServerEvent, userIds?: Iterable<string>): void {
  if (userIds) { for (const uid of userIds) sendToUser(uid, ev); return; }
  for (const s of sessions.values()) if (s.userId) send(s, ev);
}

/**
 * Eine Meldung an den Client.
 *
 * `code` ist eine Kennung aus dem Wörterbuch der Oberfläche, `werte` füllt
 * ihre Platzhalter. Der deutsche Text daneben ist nur der Rückfall für ältere
 * Clients — welche Sprache am anderen Ende läuft, muss der Server nicht
 * wissen. Wer hier eine neue Kennung einführt, legt sie in
 * packages/desktop/src/i18n/de.ts an; scripts/e2e-fehlertexte.mjs liest die
 * Kennungen aus dieser Datei und schlägt an, wenn eine ohne Eintrag bleibt.
 */
function fail(
  session: Session, code: string | undefined, message: string,
  requestId?: string, werte?: Record<string, string>,
): void {
  send(session, { t: 'error', code, message, werte, requestId });
}

/**
 * Rechteprüfung. Die Oberfläche blendet Dinge zwar aus, aber verlassen darf
 * man sich nur auf das hier — ein eigener Client könnte alles schicken.
 */
function darf(session: Session, permission: PermissionKey): boolean {
  if (!session.userId) return false;
  if (may(session.userId, permission)) return true;
  const info = PERMISSIONS.find((p) => p.key === permission);
  const name = info?.labelDe ?? permission;
  fail(session, 'fehler.keinRechtName', `Dafür fehlt dir das Recht "${name}".`,
    undefined, { recht: name });
  return false;
}

function isOnline(userId: string): boolean {
  return (byUser.get(userId)?.size ?? 0) > 0;
}

/* ── Vertrauliche Kanäle ──────────────────────────────────────── */

/**
 * Alles abweisen, was Klartext braucht.
 *
 * Übersetzung, Zusammenfassungen, Antwortvorschläge, Aufgabenerkennung und der
 * Assistent haben eines gemeinsam: sie lesen den Nachrichtentext. In einem
 * vertraulichen Kanal hat der Server keinen — er hätte also nur Base64 an ein
 * fremdes Modell zu schicken und bekäme Unsinn zurück.
 *
 * Der Aufruf steht deshalb an jeder dieser Stellen einzeln, statt einmal
 * zentral: eine Prüfung, die man beim Hinzufügen einer neuen KI-Funktion
 * vergessen kann, ist keine Prüfung. Wer eine neue Funktion baut und sie hier
 * nicht einträgt, merkt es am fehlenden Eintrag in VERTRAULICH_ABGESCHALTET.
 */
function klartextNoetig(session: Session, channelId: string | null | undefined): boolean {
  if (!channelId || !vertraulich.istVertraulich(channelId)) return false;
  fail(session, 'fehler.vertraulich',
    'In einem vertraulichen Kanal geht das nicht — der Server sieht dort nur Chiffrat. '
    + 'Übersetzung, KI-Hilfen und die serverseitige Suche sind hier bewusst abgeschaltet.');
  return true;
}

/**
 * Der Hinweis, den ein vertraulicher Kanal zurückgibt, wenn offener Text
 * ankommt. Er steht hier einmal und nicht an jeder Fundstelle: die Oberfläche
 * übersetzt anhand der Kennung, und zwei Formulierungen für denselben Fall
 * wären zwei Einträge in zweiundzwanzig Sprachen.
 */
const VERTRAULICH_NOETIG =
  'Dieser Kanal ist vertraulich. Diese App kann noch nicht verschlüsseln — bitte aktualisieren.';

/**
 * Alles abweisen, was offenen Text in einen vertraulichen Kanal schreiben will.
 *
 * Das Gegenstück zu klartextNoetig(): dort geht es um Funktionen, die den Text
 * lesen wollen, hier um solche, die welchen hineinschreiben. Die Zusage "nur
 * die Beteiligten lesen mit" hält nur, solange wirklich jeder Inhalt
 * verschlossen ankommt — ein einziger offener Weg genügt, und im Kanal steht
 * lesbarer Text, ohne dass es jemandem auffällt. Die Oberfläche blendet solche
 * Wege zwar aus, aber darauf verlassen darf man sich nicht: eine ältere Fassung
 * der App bietet sie weiter an, und eine selbstgebaute fragt gar nicht erst.
 *
 * Mehrere Texte werden alle geprüft und nicht nur der erste. Eine verschlüsselte
 * Umfragefrage mit offenen Antwortmöglichkeiten verriete das Thema genauso —
 * "Bleibt Standort Nord?" braucht die Frage gar nicht, wenn darunter "Ja,
 * schließen" steht.
 *
 * Wie bei klartextNoetig() steht der Aufruf an jeder Stelle einzeln. Eine
 * zentrale Prüfung erwischte nur die Ereignisse, die heute jemand durch sie
 * hindurchführt — und das nächste neue eben nicht.
 */
function chiffratNoetig(
  session: Session,
  channelId: string | null | undefined,
  texte: (string | null | undefined) | (string | null | undefined)[],
  hinweis: string = VERTRAULICH_NOETIG,
  kennung = 'fehler.vertraulichNoetig',
): boolean {
  if (!channelId || !vertraulich.istVertraulich(channelId)) return false;
  const alle = Array.isArray(texte) ? texte : [texte];
  // Eine leere Liste ist kein Nachweis, sondern das Fehlen eines Nachweises.
  if (alle.length > 0 && alle.every((t) => istE2EChiffrat(t))) return false;
  fail(session, kennung, hinweis);
  return true;
}

/** Dasselbe für Nachrichten, deren Kanal man erst nachschlagen muss. */
function klartextNoetigFuerNachricht(session: Session, messageId: string): boolean {
  const row = database.get<{ channel_id: string }>(
    'SELECT channel_id FROM messages WHERE id = ?', messageId,
  );
  return klartextNoetig(session, row?.channel_id);
}

/**
 * Systemnachricht in den Kanal, wenn sich am Zugang etwas ändert.
 *
 * Sie ist der Kern der Freigabe-Regelung: eine Freigabe, von der die
 * Betroffenen nichts erfahren, wäre genau die stille Hintertür, gegen die
 * diese Verschlüsselung gebaut ist. Deshalb erzeugt der Server sie selbst und
 * nicht die App der meldenden Person — sonst könnte man sie weglassen.
 *
 * Der Text steht bewusst im Klartext, obwohl der Kanal vertraulich ist: er
 * muss auch dann lesbar sein, wenn jemandem der Schlüssel fehlt, und er ist
 * kein Gesprächsinhalt, sondern eine Auskunft über den Kanal selbst.
 */
function zugangsMeldung(channelId: string, userId: string, text: string, art: string): void {
  try {
    const msg = messages.createMessage({
      channelId, userId, text, systemKind: art,
      mayMention: false, mayMentionEveryone: false,
    });
    deliverMessage(msg);
  } catch (err) {
    console.error('[vertraulich] Systemnachricht:', (err as Error).message);
  }
}

/**
 * Den Mitgliedern sagen, dass ein Schlüssel fehlt oder gewechselt werden muss.
 *
 * Der Server kann beides nicht selbst erledigen — er hat den Kanalschlüssel
 * nicht. Er kann nur fragen, und zwar alle, die ihn haben. Wer zuerst
 * antwortet, hat verpackt; die übrigen Antworten laufen ins Leere. Das ist
 * billiger als eine Absprache darüber, wer zuständig ist, und es funktioniert
 * auch dann noch, wenn die eine zuständige Person gerade im Urlaub ist.
 */
function schluesselarbeitAnstossen(channelId: string): void {
  if (!vertraulich.istVertraulich(channelId)) return;
  const fassung = vertraulich.aktuelleFassung(channelId);
  const fehlend = vertraulich.fehlendePakete(channelId, fassung);
  if (!fehlend.length) return;
  for (const uid of store.memberIds(channelId)) {
    if (fehlend.includes(uid)) continue;          // wer selbst wartet, kann nicht helfen
    if (!vertraulich.kannLesen(channelId, uid)) continue;
    sendToUser(uid, { t: 'vertraulich:pakete-fehlen', channelId, fassung, userIds: fehlend });
  }
}

/* ── Übersetzung für Empfänger ────────────────────────────────── */

/** Füllt Übersetzungen aus dem Cache und meldet, was noch fehlt. */
function fillCachedTranslations(list: Message[], lang: string): Message[] {
  const target = normalizeLang(lang);
  const need: Message[] = [];
  for (const m of list) {
    if (!m.text || m.deletedAt) continue;
    // Ein Chiffrat zu übersetzen ergäbe ein übersetztes Chiffrat.
    if (istE2EChiffrat(m.text)) continue;
    if ((m.sourceLang ?? 'unknown') === target) continue;
    const row = db.get<{ text: string; provider: string; model: string | null; confidence: number | null }>(
      'SELECT text, provider, model, confidence FROM message_translations WHERE message_id = ? AND lang = ?',
      m.id, target,
    );
    if (row) {
      m.translation = { lang: target, text: entschluesseln(row.text), provider: row.provider, model: row.model, confidence: row.confidence, cached: true };
    } else {
      need.push(m);
    }
  }
  return need;
}

/** Übersetzt fehlende Nachrichten im Hintergrund und schiebt sie nach. */
function translateInBackground(list: Message[], lang: string, userId: string, context?: string | null): void {
  const target = normalizeLang(lang);
  let chain = Promise.resolve();
  for (const m of list) {
    const key = `${m.id}:${target}`;
    chain = chain.then(async () => {
      let job = inflight.get(key);
      if (!job) {
        job = translateMessage(m.id, target, { context }).finally(() => inflight.delete(key));
        inflight.set(key, job);
      }
      const view = await job as Awaited<ReturnType<typeof translateMessage>>;
      if (view) sendToUser(userId, { t: 'translation', messageId: m.id, translation: view });
    }).catch((err) => console.error('[ws] Übersetzung fehlgeschlagen:', (err as Error).message));
  }
}

/** Kurzer Gesprächskontext, damit das Modell Anrede und Fachbegriffe trifft. */
function channelContext(channelId: string): string | null {
  const ch = db.get<{ name: string; topic: string | null; purpose: string | null }>(
    'SELECT name, topic, purpose FROM channels WHERE id = ?', channelId,
  );
  if (!ch) return null;
  const parts = [ch.name && `Kanal #${ch.name}`, ch.topic, ch.purpose].filter(Boolean);
  return parts.length ? parts.join(' — ').slice(0, 300) : null;
}

/**
 * Nachricht ausliefern: erst sofort an alle (schnell), dann pro Zielsprache
 * genau einmal übersetzen und das Ergebnis nachschieben.
 */
function deliverMessage(message: Message, senderClientId?: string): void {
  const recipients = new Set(store.memberIds(message.channelId));
  // Öffentliche Kanäle: auch Nicht-Mitglieder, die gerade zuschauen
  for (const s of sessions.values()) {
    if (s.userId && s.openChannelId === message.channelId) recipients.add(s.userId);
  }

  for (const uid of recipients) {
    const payload: ServerEvent = {
      t: 'message:new',
      message,
      ...(uid === message.userId && senderClientId ? { clientId: senderClientId } : {}),
    };
    sendToUser(uid, payload);
    const state = store.channelState(message.channelId, uid);
    if (state) sendToUser(uid, { t: 'channel:state', state });
  }

  /* Ende hier, wenn der Text verschlüsselt ist. Alles Folgende — Zielsprachen
     sammeln, übersetzen, Umfragen nachziehen — arbeitet am Klartext, und den
     gibt es nicht. Die App der empfangenden Person entschlüsselt selbst; eine
     Übersetzung gibt es in vertraulichen Kanälen bewusst nicht. */
  if (istE2EChiffrat(message.text)) return;

  // Zielsprachen einsammeln (nur für Leute, die auto-translate anhaben)
  const sourceLang = message.sourceLang ?? 'unknown';
  const langs = new Map<string, string[]>();
  for (const uid of recipients) {
    if (uid === message.userId) continue;
    const u = db.get<{ language: string; auto_translate: number; role: string }>(
      'SELECT language, auto_translate, role FROM users WHERE id = ?', uid,
    );
    // Für Bots übersetzen wäre verschenkte Rechenzeit — sie lesen nichts.
    if (!u || !u.auto_translate || u.role === 'bot') continue;
    const target = normalizeLang(u.language);
    if (target === sourceLang) continue;
    langs.set(target, [...(langs.get(target) ?? []), uid]);
  }

  // Eine Umfrage steht nicht im Nachrichtentext, sondern in eigenen Zeilen.
  // Ohne diesen Anstoß bliebe sie mitten im übersetzten Gespräch deutsch.
  if (message.poll) {
    for (const [target, users] of langs) {
      void translatePoll(message.poll.id, target, { sourceLang: message.sourceLang })
        .then((sicht) => {
          if (!sicht) return;
          for (const uid of users) {
            const poll = polls.getPoll(message.poll!.id, uid);
            if (poll) sendToUser(uid, { t: 'poll:updated', poll: { ...poll, translation: sicht }, channelId: message.channelId });
          }
        })
        .catch((err) => console.error('[ws] Umfrage-Übersetzung:', (err as Error).message));
    }
  }

  const context = channelContext(message.channelId);
  for (const [target, users] of langs) {
    const key = `${message.id}:${target}`;
    let job = inflight.get(key);
    if (!job) {
      job = translateMessage(message.id, target, { context }).finally(() => inflight.delete(key));
      inflight.set(key, job);
    }
    void job
      .then((view) => {
        if (!view) return;
        for (const uid of users) sendToUser(uid, { t: 'translation', messageId: message.id, translation: view as any });
      })
      .catch((err) => console.error('[ws] Übersetzung fehlgeschlagen:', (err as Error).message));
  }
}

/* ── Presence ─────────────────────────────────────────────────── */

/**
 * Wie lange ein selbst gesetzter Status gilt.
 *
 * Acht Stunden sind ein Arbeitstag. Wer morgens „bitte nicht stören" wählt,
 * findet es nachmittags noch vor — und am nächsten Morgen nicht mehr. Kürzer
 * wäre lästig, weil die Frist mitten in der Besprechung abliefe, für die man
 * sie gesetzt hat. Unbegrenzt wäre schlimmer: ein einmal gesetztes „abwesend"
 * bliebe wochenlang stehen, und dann glaubt niemand mehr den Punkten neben
 * den Namen.
 *
 * Solange die Frist läuft, hat die eigene Wahl Vorrang vor allem, was von
 * selbst geschieht — sonst nähme ein einziger Tastendruck sie zurück.
 */
const MANUELL_HAELT_MS = 8 * 60 * 60_000;

/**
 * Ab wann jemand ohne Zutun auf „abwesend" wandert.
 *
 * Der Server sieht keine Mausbewegung, nur Ereignisse. Eine halbe Stunde ohne
 * jede Handlung ist deshalb mit Absicht großzügig: wer lange in einem Kanal
 * liest, ohne zu wechseln oder zu schreiben, soll nicht fälschlich abwesend
 * erscheinen. Der genaue Wächter sitzt in der Oberfläche (StatusMenu) und
 * meldet schon nach fünf Minuten ohne Eingabe; das hier ist das Netz für
 * alles, was ihn nicht mitbringt — ältere Apps und fremde Clients.
 */
const LEERLAUF_MS = 30 * 60_000;

/** Wann jemand zuletzt etwas getan hat, hinter dem ein Mensch stecken muss. */
const letzteAktion = new Map<string, number>();

/**
 * Ereignisse, die als Lebenszeichen zählen.
 *
 * Bewusst eine Auswahlliste und keine Ausnahmeliste: alles Neue gilt erst
 * einmal als Hintergrundrauschen, statt versehentlich jemanden wachzuhalten.
 * Nicht dabei ist vor allem "read" — das schickt die Oberfläche von selbst,
 * sobald in einem sichtbaren Fenster eine Nachricht ankommt. Ein vergessener,
 * offener Rechner bliebe damit für immer grün, und genau das ist der Fehler,
 * den dieser Wächter beheben soll.
 */
const MENSCHLICHE_EREIGNISSE = new Set<string>([
  'message:send', 'message:edit', 'message:delete', 'message:react',
  'message:pin', 'message:forward', 'message:schedule', 'typing', 'draft:save',
  'channel:open', 'channel:create', 'channel:join', 'channel:leave',
  'thread:open', 'dm:open', 'poll:create', 'poll:vote', 'voice:send',
  'task:create', 'task:update', 'task:move', 'task:comment',
  'idea:create', 'idea:vote', 'idea:comment', 'event:create', 'event:respond',
  'vorschlag:accept', 'vorschlag:reject', 'vorschlag:undo',
  'ai:ask', 'ai:rewrite', 'compose:preview',
]);

/** Gilt der selbst gesetzte Status gerade noch? */
function statusHaelt(userId: string): boolean {
  return (store.getUser(userId)?.statusExpiresAt ?? 0) > Date.now();
}

/**
 * Ein Lebenszeichen verbuchen — und wer wieder da ist, ist wieder online.
 *
 * Die Rückkehr geschieht nur aus einem von selbst entstandenen „abwesend".
 * Eine eigene Wahl bleibt stehen, solange ihre Frist läuft; sonst hätte das
 * Statusmenü keinen Wert, weil schon das Tippen einer Antwort sie zurücknähme.
 */
function aktivitaetMerken(userId: string): void {
  letzteAktion.set(userId, Date.now());
  if (statusHaelt(userId)) return;
  if (store.getUser(userId)?.status === 'away') setStatus(userId, 'online');
}

function setStatus(
  userId: string, status: UserStatus,
  emoji?: string | null, text?: string | null, expiresAt?: number | null,
): void {
  const sets = ['status = ?', 'last_seen_at = ?'];
  const vals: any[] = [status, Date.now()];
  if (emoji !== undefined) { sets.push('status_emoji = ?'); vals.push(emoji); }
  if (text !== undefined) { sets.push('status_text = ?'); vals.push(text); }
  if (expiresAt !== undefined) { sets.push('status_expires_at = ?'); vals.push(expiresAt); }
  db.run(`UPDATE users SET ${sets.join(', ')} WHERE id = ?`, ...vals, userId);

  const u = store.getUser(userId);
  if (!u) return;
  const ereignis = {
    t: 'presence' as const, userId, status: u.status,
    statusEmoji: u.statusEmoji, statusText: u.statusText,
    statusExpiresAt: u.statusExpiresAt, lastSeenAt: u.lastSeenAt,
  };

  /*
   * „Unsichtbar" ist offline bei stehender Verbindung — und muss von einem
   * echten offline ununterscheidbar sein, sonst ist es das Versprechen nicht
   * wert. Die Frist daneben würde es verraten: an ihr sähe man, dass hier
   * jemand ausdrücklich gewählt hat, statt einfach fort zu sein. Die Person
   * selbst bekommt sie weiterhin, sie gehört zu ihrem eigenen Menü.
   */
  if (u.status === 'offline' && u.statusExpiresAt !== null) {
    sendToUser(userId, ereignis);
    broadcast({ ...ereignis, statusExpiresAt: null },
      [...byUser.keys()].filter((id) => id !== userId));
    return;
  }
  broadcast(ereignis);
}

/* ── Verbindungsaufbau ────────────────────────────────────────── */

export function handleConnection(socket: WebSocket): void {
  const session: Session = {
    id: newId('s_'), socket, userId: null, language: 'en',
    autoTranslate: true, openChannelId: null, alive: true,
  };
  sessions.set(session.id, session);

  const authTimer = setTimeout(() => {
    if (!session.userId) { fail(session, 'fehler.anmeldungZeit', 'Keine Anmeldung innerhalb von 10 Sekunden'); socket.close(); }
  }, 10_000);

  socket.on('message', (raw: Buffer | string) => {
    /* Wer etwas schickt, lebt — unabhängig davon, ob die Gegenstelle auf
       Protokoll-Pings antwortet. Manche Zwischenstellen schlucken die
       Ping/Pong-Rahmen; ohne diese Zeile würfe der Wächter unten eine
       einwandfreie Verbindung alle 60 Sekunden weg, und die Person flackerte
       für alle anderen zwischen online und offline. */
    session.alive = true;
    const ev = decode<ClientEvent>(raw.toString());
    if (!ev || typeof ev.t !== 'string') return;
    if (ev.t === 'auth') {
      clearTimeout(authTimer);
      // Ohne dieses catch würde ein Fehler beim Anmelden — eine hakende
      // Datenbank genügt — als unbehandelte Zurückweisung den ganzen Server
      // mitreißen, mitsamt allen anderen Verbindungen.
      void authenticate(session, ev).catch((err) => {
        console.error('[ws] Anmeldung:', (err as Error).message);
        fail(session, 'fehler.anmeldungFehlgeschlagen', 'Anmeldung fehlgeschlagen. Bitte noch einmal versuchen.');
        session.socket.close();
      });
      return;
    }
    if (!session.userId) { fail(session, 'fehler.nichtAngemeldet', 'Bitte zuerst anmelden'); return; }
    void handleEvent(session, ev).catch((err) => {
      console.error('[ws]', ev.t, (err as Error).message);
      /* Trägt der Wurf eine Kennung, geht die mit hinaus und die Oberfläche
         setzt ihren eigenen Satz ein. Trägt er keine, bleibt es beim
         deutschen Text des Dienstes: „Nur eigene Nachrichten lassen sich
         bearbeiten" sagt einer Person mehr als ein übersetztes „etwas ist
         schiefgegangen" — das klänge nach einem Serverfehler, wo in Wahrheit
         nur ein Titel fehlt. Lieber genau und deutsch als übersetzt und falsch.
         Wer einen dieser Würfe auf abweisung() umstellt, macht ihn übersetzbar. */
      const { code, werte } = kennungVon(err);
      fail(session, code, (err as Error).message, (ev as any).requestId, werte);
    });
  });

  socket.on('pong', () => { session.alive = true; });

  socket.on('close', () => {
    clearTimeout(authTimer);
    sessions.delete(session.id);
    if (session.userId) {
      const set = byUser.get(session.userId);
      set?.delete(session);
      if (set && set.size === 0) {
        byUser.delete(session.userId);
        /* Der Merker darf nicht überleben: käme dieselbe Person morgen wieder,
           läse der Leerlaufwächter einen uralten Zeitpunkt und stellte sie
           sofort auf abwesend. */
        letzteAktion.delete(session.userId);
        setStatus(session.userId, 'offline');
      }
    }
  });

  socket.on('error', () => { /* close folgt */ });
}

async function authenticate(session: Session, ev: Extract<ClientEvent, { t: 'auth' }>): Promise<void> {
  if (ev.protocol !== WS_PROTOCOL_VERSION) {
    fail(session, 'fehler.protokollVeraltet',
      `Client-Protokoll ${ev.protocol}, Server erwartet ${WS_PROTOCOL_VERSION}. Bitte App aktualisieren.`,
      undefined, { client: String(ev.protocol), server: String(WS_PROTOCOL_VERSION) });
    session.socket.close();
    return;
  }
  const userId = verifyToken(ev.token);
  if (!userId) { fail(session, 'fehler.anmeldungAbgelaufen', 'Anmeldung abgelaufen'); session.socket.close(); return; }

  const self = store.getSelf(userId);
  if (!self) { fail(session, 'fehler.kontoWeg', 'Konto existiert nicht mehr'); session.socket.close(); return; }

  /* Ein gültiges Token allein genügt nicht: Sperren und Löschen wirkten sonst
     erst, wenn das Token nach 30 Tagen abläuft — bis dahin bliebe der Zugang
     bestehen. Bei jeder Anmeldung wird deshalb der Kontostand mitgeprüft. */
  const stand = database.get<{ deleted_at: number | null }>(
    'SELECT deleted_at FROM users WHERE id = ?', userId,
  );
  if (stand?.deleted_at) {
    fail(session, 'fehler.kontoInaktiv', 'Dieses Konto ist nicht mehr aktiv.');
    session.socket.close();
    return;
  }

  session.userId = userId;
  session.language = normalizeLang(self.language);
  session.autoTranslate = self.autoTranslate;

  const set = byUser.get(userId) ?? new Set<Session>();
  const wasOffline = set.size === 0;
  set.add(session);
  byUser.set(userId, set);

  send(session, {
    t: 'ready',
    self,
    users: store.listUsers().map((u) => ({
      ...u,
      status: isOnline(u.id) ? u.status : 'offline',
      // Aus demselben Grund wie in setStatus: die Frist verriete ein „unsichtbar".
      statusExpiresAt: u.id === userId || u.status !== 'offline' ? u.statusExpiresAt : null,
    })),
    channels: store.visibleChannels(userId),
    states: store.channelStates(userId),
    scheduled: store.scheduledFor(userId),
    reminders: reminders.remindersFor(userId),
    drafts: drafts.draftsFor(userId),
    serverTime: Date.now(),
    serverVersion: config.version,
    /* Auch ohne Verwaltungsrecht soll jeder sehen, dass gleich neu gestartet
       wird — die Liste der Fassungen bekommt nur die Verwaltung zu sehen. */
    serverUpdate: (() => {
      const bereit = releases.getRelease('server');
      return bereit && releases.istNeuer(bereit.version, config.version) ? bereit.version : null;
    })(),
    ai: aiCapabilities(),
  });

  // Steht eine Auszeit an, soll auch wer gerade erst kommt sie sehen.
  const auszeit = wartung.anstehend();
  if (auszeit) {
    send(session, {
      t: 'server:update',
      ...auszeit,
      serverZeit: Date.now(),
    });
  }

  /* Ohne diese Zeile hielte der Leerlaufwächter unten den Zeitpunkt 0 für die
     letzte Handlung und stellte jeden sofort nach dem Anmelden auf abwesend. */
  letzteAktion.set(userId, Date.now());

  if (wasOffline) {
    /*
     * Ein selbst gesetzter Status übersteht den Verbindungsabriss, solange
     * seine Frist läuft. Vorher wurde hier stur „offline" zu „online" — und
     * damit war „unsichtbar" nach dem ersten Netzwackler aufgehoben, ohne
     * dass die Person etwas davon merkte. Läuft keine Frist mehr, ist online
     * der ehrliche Wert: die App ist ja gerade wieder da.
     */
    setStatus(userId, statusHaelt(userId) ? self.status : 'online');
  }

  // Kanalnamen und -themen in die Lesesprache bringen. Im Hintergrund, damit
  // die Oberfläche sofort steht; die Übersetzungen kommen nach.
  if (self.autoTranslate) {
    for (const kanal of store.visibleChannels(userId)) {
      if (kanal.kind === 'dm' || kanal.translation) continue;
      void kanalUebersetzungNachreichen(kanal.id, userId);
    }
  }
}

/* ── Einstellungen ────────────────────────────────────────────── */

/**
 * Was 'prefs:update' schreiben darf — und in welcher Form.
 *
 * Vorher stand hier nur eine Zuordnung von Feldname zu Spalte, und der Wert
 * ging ungeprüft in das UPDATE. Damit ließ sich über diesen Weg alles
 * hineinschreiben, was ein eigener Client schickte: ein Anzeigename mit
 * sechzigtausend Zeichen (bei der Ersteinrichtung sind achtzig die Grenze),
 * ein Sprachkürzel, das es nicht gibt, ein Aussehen namens „lila". Der
 * Anzeigename ging von dort per user:upsert an jede offene Verbindung im
 * Haus, das Sprachkürzel in jede Übersetzungsanfrage.
 *
 * `pruefen` gibt den Wert zurück, der geschrieben werden soll, oder
 * `undefined` — dann bleibt das Feld unangetastet.
 */
const EINSTELLUNGEN: Record<string, { spalte: string; pruefen: (w: unknown) => unknown }> = {
  language: { spalte: 'language', pruefen: (w) => sprache(w) },
  /* Die Sprache der Oberfläche gibt es auch als "gar nicht gesetzt" — dann
     gilt die Übersetzungssprache. Deshalb ist null hier ein gültiger Wert. */
  uiLanguage: { spalte: 'ui_language', pruefen: (w) => (w === null ? null : sprache(w)) },
  autoTranslate: { spalte: 'auto_translate', pruefen: (w) => (typeof w === 'boolean' ? (w ? 1 : 0) : undefined) },
  composeTargetPreview: { spalte: 'compose_target_preview', pruefen: (w) => (typeof w === 'boolean' ? (w ? 1 : 0) : undefined) },
  notifyOn: { spalte: 'notify_on', pruefen: (w) => ausListe(w, ['all', 'mentions', 'none']) },
  theme: { spalte: 'theme', pruefen: (w) => ausListe(w, ['system', 'dark', 'light']) },
  density: { spalte: 'density', pruefen: (w) => ausListe(w, ['comfortable', 'compact']) },
  notificationSound: { spalte: 'notification_sound', pruefen: (w) => ausListe(w, ['ping', 'blip', 'chime', 'aus']) },
  translationSpeed: { spalte: 'translation_speed', pruefen: (w) => ausListe(w, ['fast', 'balanced', 'accurate']) },
  /* Dieselbe Grenze wie in users.completeSetup(). Sie stand dort allein, und
     damit war sie keine Grenze, sondern eine Höflichkeit. */
  displayName: { spalte: 'display_name', pruefen: (w) => text(w, 80, { leerErlaubt: false }) },
  title: { spalte: 'title', pruefen: (w) => text(w, 120) },
  timezone: { spalte: 'timezone', pruefen: (w) => text(w, 64) },
  // Minuten seit Mitternacht; null hebt die Ruhezeit auf.
  quietHoursStart: { spalte: 'quiet_hours_start', pruefen: (w) => minuten(w) },
  quietHoursEnd: { spalte: 'quiet_hours_end', pruefen: (w) => minuten(w) },
};

function sprache(w: unknown): string | undefined {
  if (typeof w !== 'string') return undefined;
  const code = normalizeLang(w);
  return isSupportedLang(code) ? code : undefined;
}

function ausListe(w: unknown, erlaubt: string[]): string | undefined {
  return typeof w === 'string' && erlaubt.includes(w) ? w : undefined;
}

function text(w: unknown, grenze: number, opt: { leerErlaubt?: boolean } = {}): string | null | undefined {
  if (w === null) return opt.leerErlaubt === false ? undefined : null;
  if (typeof w !== 'string') return undefined;
  const sauber = w.trim().slice(0, grenze);
  if (!sauber) return opt.leerErlaubt === false ? undefined : null;
  return sauber;
}

function minuten(w: unknown): number | null | undefined {
  if (w === null) return null;
  if (typeof w !== 'number' || !Number.isFinite(w)) return undefined;
  const m = Math.trunc(w);
  return m >= 0 && m < 1440 ? m : undefined;
}

/* ── Event-Dispatch ───────────────────────────────────────────── */

async function handleEvent(session: Session, ev: ClientEvent): Promise<void> {
  const userId = session.userId!;

  /* Ein Ereignis von hier ist der einzige Hinweis, den der Server darauf hat,
     dass jemand tatsächlich am Rechner sitzt. */
  if (MENSCHLICHE_EREIGNISSE.has(ev.t)) aktivitaetMerken(userId);

  switch (ev.t) {
    case 'ping':
      send(session, { t: 'pong', ts: ev.ts });
      return;

    case 'channel:open': {
      const ch = store.getChannel(ev.channelId, userId);
      if (!ch) return fail(session, 'fehler.kanalNichtGefunden', 'Kanal nicht gefunden');
      if (ch.kind !== 'public' && !store.isMember(ch.id, userId)) {
        return fail(session, 'fehler.keinKanalZugriff', 'Kein Zugriff auf diesen Kanal');
      }
      session.openChannelId = ch.id;

      /* Math.min allein reicht nicht: eine negative Zahl kommt kleiner durch
         und wird in SQL zu LIMIT -1 — das liefert den ganzen Kanal auf einmal.
         Dieselbe Regel wie bei der Suche, und sie steht dort: eine Zahl, die
         keine brauchbare Grenze ist, wird auf die Vorgabe zurückgesetzt. */
      const wieviele = grenze(ev.limit, 50, 100);
      const { messages: list, hasMore } = store.channelHistory(ch.id, ev.before ?? null, wieviele, userId);
      const missing = session.autoTranslate ? fillCachedTranslations(list, session.language) : [];
      send(session, { t: 'channel:history', channelId: ch.id, messages: list, hasMore });
      if (missing.length) translateInBackground(missing, session.language, userId, channelContext(ch.id));
      /* Beim Öffnen gleich mitschicken, was zum Entschlüsseln nötig ist —
         sonst müsste die App erst merken, dass sie nichts lesen kann, und
         dann nachfragen. Das sähe für einen Wimpernschlag aus wie ein
         kaputter Kanal. */
      if (ch.vertraulich) {
        send(session, {
          t: 'vertraulich:paket', channelId: ch.id,
          fassung: vertraulich.aktuelleFassung(ch.id),
          pakete: vertraulich.paketeFuer(ch.id, userId),
        });
        schluesselarbeitAnstossen(ch.id);
      }
      return;
    }

    case 'channel:create': {
      if (!darf(session, ev.kind === 'private' ? 'channel.create_private' : 'channel.create')) return;
      const ch = channels.createChannel({
        kind: ev.kind, name: ev.name, topic: ev.topic ?? null,
        primaryLanguage: ev.primaryLanguage ?? null, createdBy: userId, memberIds: ev.memberIds,
      });
      const audience = ev.kind === 'public' ? undefined : ch.memberIds;
      broadcast({ t: 'channel:upsert', channel: ch }, audience);
      for (const uid of ch.memberIds) {
        const st = store.channelState(ch.id, uid);
        if (st) sendToUser(uid, { t: 'channel:state', state: st });
      }
      return;
    }

    case 'channel:join': {
      const ch = channels.joinChannel(ev.channelId, userId);
      sendToUser(userId, { t: 'channel:upsert', channel: ch });
      const st = store.channelState(ch.id, userId);
      if (st) sendToUser(userId, { t: 'channel:state', state: st });
      const sys = messages.createMessage({
        channelId: ch.id, userId, text: `@${store.getUser(userId)?.handle} ist dem Kanal beigetreten`, systemKind: 'join',
      });
      deliverMessage(sys);
      return;
    }

    case 'channel:leave': {
      const warVertraulich = vertraulich.istVertraulich(ev.channelId);
      channels.leaveChannel(ev.channelId, userId);
      sendToUser(userId, { t: 'channel:removed', channelId: ev.channelId });
      kanalElementeZuruecknehmen(ev.channelId, [userId]);
      /* Wer geht, nimmt den Kanalschlüssel auf seinem Gerät mit. Ohne Wechsel
         läse er alles Neue weiter mit — er müsste den Kanal dafür nicht einmal
         sehen, ein mitgeschriebenes Chiffrat genügte. */
      if (warVertraulich) {
        for (const uid of store.memberIds(ev.channelId)) {
          if (!vertraulich.kannLesen(ev.channelId, uid)) continue;
          sendToUser(uid, {
            t: 'vertraulich:wechsel-noetig', channelId: ev.channelId,
            grund: 'Jemand hat den Kanal verlassen.',
          });
        }
      }
      return;
    }

    case 'channel:update': {
      // Nach einer Änderung sind alte Übersetzungen hinfällig; die Prüfsumme
      // sorgt dafür, dass sie beim nächsten Anfassen neu entstehen.
      if (!darf(session, ev.archived !== undefined ? 'channel.archive' : 'channel.manage')) return;
      const ch = channels.updateChannel(ev.channelId, {
        name: ev.name, topic: ev.topic, purpose: ev.purpose,
        primaryLanguage: ev.primaryLanguage, archived: ev.archived, readOnly: ev.readOnly,
      });
      if (ch) broadcast({ t: 'channel:upsert', channel: ch }, ch.kind === 'public' ? undefined : ch.memberIds);
      return;
    }

    case 'channel:delete': {
      if (!darf(session, 'channel.delete')) return;
      const betroffen = store.memberIds(ev.channelId);
      const info = channels.deleteChannel(ev.channelId);
      broadcast({ t: 'channel:removed', channelId: ev.channelId }, betroffen);
      console.log(`[kanal] #${info.name} gelöscht (${info.messages} Nachrichten) von ${userId}`);
      return;
    }

    case 'channel:hide': {
      /* Bei einem gewöhnlichen Kanal tut Ausblenden dasselbe wie Verlassen:
         die Mitgliedschaft fällt weg (siehe channels.hideChannel). Der
         Schlüsselwechsel hing aber allein an 'channel:leave' — wer stattdessen
         ausblendete, ging mit dem Kanalschlüssel auf seinem Gerät hinaus, und
         im Kanal merkte es niemand. Zwei Wege, eine Wirkung: dann gehört auch
         dieselbe Folge daran. */
      const warVertraulich = vertraulich.istVertraulich(ev.channelId);
      const warMitglied = store.isMember(ev.channelId, userId);
      channels.hideChannel(ev.channelId, userId);
      sendToUser(userId, { t: 'channel:removed', channelId: ev.channelId });
      kanalElementeZuruecknehmen(ev.channelId, [userId]);
      if (warVertraulich && warMitglied && !store.isMember(ev.channelId, userId)) {
        for (const uid of store.memberIds(ev.channelId)) {
          if (!vertraulich.kannLesen(ev.channelId, uid)) continue;
          sendToUser(uid, {
            t: 'vertraulich:wechsel-noetig', channelId: ev.channelId,
            grund: 'Jemand hat den Kanal verlassen.',
          });
        }
      }
      return;
    }

    case 'channel:members': {
      if (!darf(session, 'channel.members')) return;
      const ch = channels.setMembers(ev.channelId, ev.add ?? [], ev.remove ?? []);
      // Neue Mitglieder brauchen den Kanal, entfernte sollen ihn verlieren.
      for (const uid of ch.memberIds) {
        sendToUser(uid, { t: 'channel:upsert', channel: store.getChannel(ch.id, uid)! });
        const st = store.channelState(ch.id, uid);
        if (st) sendToUser(uid, { t: 'channel:state', state: st });
      }
      for (const uid of ev.remove ?? []) {
        if (!ch.memberIds.includes(uid)) sendToUser(uid, { t: 'channel:removed', channelId: ch.id });
      }
      kanalElementeZuruecknehmen(ch.id, ev.remove ?? []);

      /* Vertrauliche Kanäle: Aufnahme heißt verpacken, Entfernen heißt
         wechseln. Beides kann nur eine App erledigen, die den Kanalschlüssel
         hat — der Server bittet lediglich darum. Der Wechsel steht zuerst,
         weil er der dringendere ist: bis er passiert, liest die entfernte
         Person alles Neue weiter mit. */
      if (ch.vertraulich) {
        if ((ev.remove ?? []).length) {
          for (const uid of ch.memberIds) {
            if (!vertraulich.kannLesen(ch.id, uid)) continue;
            sendToUser(uid, {
              t: 'vertraulich:wechsel-noetig', channelId: ch.id,
              grund: 'Jemand hat den Kanal verlassen.',
            });
          }
        }
        schluesselarbeitAnstossen(ch.id);
      }
      return;
    }

    case 'channel:mute': {
      channels.setMuted(ev.channelId, userId, ev.muted);
      const st = store.channelState(ev.channelId, userId);
      if (st) send(session, { t: 'channel:state', state: st });
      return;
    }

    case 'channel:star': {
      channels.setStarred(ev.channelId, userId, ev.starred);
      const st = store.channelState(ev.channelId, userId);
      if (st) send(session, { t: 'channel:state', state: st });
      return;
    }

    case 'dm:open': {
      if (!darf(session, 'dm.start')) return;
      const ch = channels.openDm(userId, ev.userId);
      for (const uid of ch.memberIds) {
        sendToUser(uid, { t: 'channel:upsert', channel: store.getChannel(ch.id, uid)! });
        const st = store.channelState(ch.id, uid);
        if (st) sendToUser(uid, { t: 'channel:state', state: st });
      }
      session.openChannelId = ch.id;
      const { messages: list, hasMore } = store.channelHistory(ch.id, null, 50, userId);
      const missing = session.autoTranslate ? fillCachedTranslations(list, session.language) : [];
      send(session, { t: 'channel:history', channelId: ch.id, messages: list, hasMore });
      /* channel:upsert geht an alle Mitglieder des Direktchats. Wer daraus
         navigiert, reißt auch den Gegenüber aus seinem Kanal — springen darf
         nur die Session, die den Chat gerade geöffnet hat. Erst nach dem
         Verlauf, sonst zeigt die Ansicht kurz einen leeren Kanal. */
      send(session, { t: 'channel:focus', channelId: ch.id });
      if (missing.length) translateInBackground(missing, session.language, userId, null);
      return;
    }

    case 'message:send': {
      if (!darf(session, 'message.send')) return;
      const ch = store.getChannel(ev.channelId, userId);
      if (!ch) return fail(session, 'fehler.kanalNichtGefunden', 'Kanal nicht gefunden');
      if (ch.kind !== 'public' && !store.isMember(ch.id, userId)) {
        return fail(session, 'fehler.keinKanalZugriff', 'Kein Zugriff auf diesen Kanal');
      }
      if (ch.kind === 'public') channels.ensureMember(ch.id, userId);

      // Ankündigungskanäle: nur wer sie verwalten darf, schreibt auch hinein.
      if (ch.readOnly && !may(userId, 'channel.manage')) {
        return fail(session, 'fehler.nurKanalverwaltung', 'In diesen Kanal schreibt nur die Kanalverwaltung.');
      }

      /* In einem vertraulichen Kanal nimmt der Server keinen Klartext an.
         Das ist die Stelle, an der die Zusage steht oder fällt: eine App mit
         altem Stand — oder eine selbstgebaute — würde sonst munter unverschlüsselt
         hineinschreiben, und niemandem im Kanal fiele es auf. Lieber eine
         abgewiesene Nachricht als eine, die stillschweigend offen liegt. */
      if (chiffratNoetig(session, ch.id, ev.text)) return;

      // Wer einen Chat ausgeblendet hat, soll ihn bei neuer Aktivität wiedersehen.
      channels.unhideForAll(ch.id);

      // Erwähnungen sind ein eigenes Recht: wer es nicht hat, soll das auch
      // erfahren, statt dass die Benachrichtigung still verschluckt wird.
      const darfErwaehnen = may(userId, 'mention.user');
      const darfAlle = may(userId, 'mention.everyone');
      if (!darfErwaehnen && extractMentions(ev.text).length > 0) {
        return fail(session, 'fehler.keinRechtErwaehnen', 'Dafür fehlt dir das Recht "Personen erwähnen".');
      }
      if (!darfAlle && mentionsEveryone(ev.text)) {
        return fail(session, 'fehler.keinRechtAlleErwaehnen', 'Dafür fehlt dir das Recht "Alle erwähnen".');
      }

      const msg = messages.createMessage({
        channelId: ch.id, userId, text: ev.text, parentId: ev.parentId ?? null,
        attachmentIds: ev.attachmentIds, sourceLang: ev.sourceLang ?? null,
        mayMention: darfErwaehnen, mayMentionEveryone: darfAlle,
      });
      messages.markRead(ch.id, userId, msg.id);
      deliverMessage(msg, ev.clientId);
      enrichLinks(msg.id, msg.text, ch.id);
      vielleichtAntworten(ch.id, msg.text, userId);
      return;
    }

    case 'message:edit': {
      if (!darf(session, 'message.edit_own')) return;
      if (!may(userId, 'mention.user') && extractMentions(ev.text).length > 0) {
        return fail(session, 'fehler.keinRechtErwaehnen', 'Dafür fehlt dir das Recht "Personen erwähnen".');
      }
      /* Dieselbe Zusage wie beim Senden: eine Bearbeitung darf eine
         verschlüsselte Nachricht nicht in eine offene verwandeln. */
      const kanalDerNachricht = database.get<{ channel_id: string }>(
        'SELECT channel_id FROM messages WHERE id = ?', ev.messageId,
      )?.channel_id;
      if (chiffratNoetig(session, kanalDerNachricht, ev.text)) return;
      const msg = messages.editMessage(ev.messageId, userId, ev.text);
      broadcast({ t: 'message:updated', message: msg }, store.memberIds(msg.channelId));
      // Neu übersetzen für alle, die zuschauen
      const targets = new Set<string>();
      for (const uid of store.memberIds(msg.channelId)) {
        if (uid === userId || !isOnline(uid)) continue;
        const u = store.getUser(uid);
        if (u?.autoTranslate) targets.add(normalizeLang(u.language));
      }
      for (const lang of targets) {
        void translateMessage(msg.id, lang, { force: true, context: channelContext(msg.channelId) })
          .then((view) => {
            if (!view) return;
            for (const uid of store.memberIds(msg.channelId)) {
              const u = store.getUser(uid);
              if (u && u.autoTranslate && normalizeLang(u.language) === lang) {
                sendToUser(uid, { t: 'translation', messageId: msg.id, translation: view });
              }
            }
          })
          .catch(() => { /* Original bleibt sichtbar */ });
      }
      return;
    }

    case 'message:delete': {
      // Ohne diese Prüfung genügte eine bekannte Kennung, um Nachrichten in
      // fremden Kanälen und Direktchats verschwinden zu lassen.
      if (!darfNachrichtAendern(userId, ev.messageId)) {
        return fail(session, 'fehler.keinNachrichtZugang', 'Zu dieser Nachricht hast du keinen Zugang.');
      }
      const scope = ev.scope ?? 'all';
      const eigene = store.getMessage(ev.messageId)?.userId === userId;
      // Für sich ausblenden darf jede:r immer — das ändert nichts für andere.
      if (scope === 'all' && !darf(session, eigene ? 'message.delete_own' : 'message.delete_any')) return;

      const ergebnis = messages.deleteMessage(ev.messageId, userId, may(userId, 'message.delete_any'), scope);
      if (ergebnis.scope === 'me') {
        // Nur die eigene Ansicht ändert sich.
        send(session, { t: 'message:deleted', messageId: ev.messageId, channelId: ergebnis.channelId });
      } else {
        broadcast({ t: 'message:deleted', messageId: ev.messageId, channelId: ergebnis.channelId },
          store.memberIds(ergebnis.channelId));
      }
      return;
    }

    case 'message:react': {
      if (!darf(session, 'reaction.add')) return;
      // Sonst ließe sich in fremden Kanälen reagieren — sichtbar für alle dort.
      if (!darfNachrichtAendern(userId, ev.messageId)) {
        return fail(session, 'fehler.keinNachrichtZugang', 'Zu dieser Nachricht hast du keinen Zugang.');
      }
      const { channelId } = messages.toggleReaction(ev.messageId, userId, ev.emoji);
      const msg = store.getMessage(ev.messageId);
      if (msg) broadcast({ t: 'reaction:updated', messageId: msg.id, channelId, reactions: msg.reactions }, store.memberIds(channelId));
      return;
    }

    case 'message:pin': {
      if (!darf(session, 'message.pin')) return;
      // Sonst ließe sich in fremden Kanälen anheften — sichtbar für alle dort.
      if (!darfNachrichtSehen(userId, ev.messageId)) return;
      const msg = messages.setPinned(ev.messageId, ev.pinned);
      if (msg) broadcast({ t: 'message:updated', message: msg }, store.memberIds(msg.channelId));
      return;
    }

    case 'message:save':
      if (!darfNachrichtSehen(userId, ev.messageId)) {
        return fail(session, 'fehler.keinNachrichtZugang', 'Zu dieser Nachricht hast du keinen Zugang.');
      }
      messages.setSaved(ev.messageId, userId, ev.saved);
      return;

    case 'message:schedule': {
      if (!darf(session, 'message.schedule')) return;
      // Ohne diese Prüfung ließe sich in jeden Kanal schreiben — auch in
      // private und in fremde Direktchats. Nur eben zeitversetzt.
      if (!store.getChannel(ev.channelId, userId) || !store.isMember(ev.channelId, userId)) {
        return fail(session, 'fehler.keinKanalZugriff', 'Kein Zugriff auf diesen Kanal');
      }
      if (chiffratNoetig(session, ev.channelId, ev.text,
        'Dieser Kanal ist vertraulich. Eine geplante Nachricht muss schon beim Planen verschlüsselt sein — '
        + 'sonst läge sie bis zum Absenden offen auf dem Server.',
        'fehler.vertraulichGeplantNoetig')) return;
      const id = messages.scheduleMessage({
        channelId: ev.channelId, userId, text: ev.text, sendAt: ev.sendAt, parentId: ev.parentId ?? null,
      });
      const item = db.get('SELECT * FROM scheduled_messages WHERE id = ?', id);
      if (item) send(session, { t: 'scheduled:upsert', item: store.toScheduled(item) });
      return;
    }

    case 'message:unschedule':
      if (messages.cancelScheduled(ev.scheduledId, userId)) {
        sendToUser(userId, { t: 'scheduled:removed', scheduledId: ev.scheduledId });
      }
      return;

    case 'thread:open': {
      if (!darfNachrichtSehen(userId, ev.messageId)) {
        return fail(session, 'fehler.keinNachrichtZugang', 'Zu dieser Nachricht hast du keinen Zugang.');
      }
      const list = store.threadHistory(ev.messageId, userId);
      if (!list.length) return fail(session, 'fehler.threadNichtGefunden', 'Thread nicht gefunden');
      const missing = session.autoTranslate ? fillCachedTranslations(list, session.language) : [];
      send(session, { t: 'thread:history', parentId: ev.messageId, channelId: list[0].channelId, messages: list });
      if (missing.length) translateInBackground(missing, session.language, userId, channelContext(list[0].channelId));
      return;
    }

    case 'typing': {
      /* Ohne Zugang kein Lebenszeichen. Still abgewiesen wie draft:save: das
         schickt die Oberfläche beim Tippen nebenher, eine Meldung pro
         Tastendruck hülfe niemandem. Ohne diese Zeile konnte jede Person mit
         der Kennung eines privaten Kanals dort „schreibt gerade" erscheinen
         lassen — sichtbar für alle Mitglieder. */
      if (!darfKanalSehen(userId, ev.channelId)) return;
      const audience = store.memberIds(ev.channelId).filter((uid) => uid !== userId);
      broadcast({ t: 'typing', channelId: ev.channelId, userId, parentId: ev.parentId ?? null }, audience);
      return;
    }

    case 'read': {
      // Dasselbe wie bei 'typing': ohne Zugang zum Kanal geht die Meldung
      // nicht an dessen Mitglieder hinaus.
      if (!darfKanalSehen(userId, ev.channelId)) return;
      messages.markRead(ev.channelId, userId, ev.lastMessageId);
      const st = store.channelState(ev.channelId, userId);
      if (st) send(session, { t: 'channel:state', state: st });
      broadcast({ t: 'read', channelId: ev.channelId, userId, lastMessageId: ev.lastMessageId },
        store.memberIds(ev.channelId).filter((uid) => uid !== userId));
      return;
    }

    case 'presence:set': {
      /*
       * Zwei Absender, ein Ereignis — unterschieden an der Frist:
       *
       *   fehlt sie      -> ein Mensch hat gewählt. Der Server legt seine
       *                     Regelfrist darüber, damit die Wahl eine Weile hält.
       *   ist sie null   -> der Leerlaufwächter der Oberfläche meldet, was er
       *                     beobachtet hat. Das darf eine laufende eigene Wahl
       *                     nicht verdrängen.
       *   ist sie eine Zahl -> ausdrücklich bis dahin.
       *
       * „online" bekommt bei eigener Wahl keine Frist: es ist der Zustand, in
       * den alles von selbst zurückfällt. Ihn festzuhalten hieße, den
       * Leerlaufwächter für acht Stunden abzuschalten.
       */
      const automatisch = ev.statusExpiresAt === null;
      if (automatisch && statusHaelt(userId)) return;
      const frist = automatisch
        ? null
        : ev.statusExpiresAt ?? (ev.status === 'online' ? null : Date.now() + MANUELL_HAELT_MS);
      if (!automatisch) letzteAktion.set(userId, Date.now());
      setStatus(userId, ev.status, ev.statusEmoji, ev.statusText, frist);
      return;
    }

    case 'prefs:update': {
      const sets: string[] = [];
      const vals: any[] = [];
      for (const [key, value] of Object.entries(ev.patch)) {
        const feld = EINSTELLUNGEN[key];
        if (!feld) continue;
        const wert = feld.pruefen(value);
        // Was nicht durchkommt, wird still übergangen — wie bisher schon jedes
        // unbekannte Feld. Eine Meldung pro verworfenem Wert hülfe niemandem.
        if (wert === undefined) continue;
        sets.push(`${feld.spalte} = ?`);
        vals.push(wert);
      }
      if (!sets.length) return;
      db.run(`UPDATE users SET ${sets.join(', ')} WHERE id = ?`, ...vals, userId);

      const self = store.getSelf(userId)!;
      session.language = normalizeLang(self.language);
      session.autoTranslate = self.autoTranslate;
      for (const s of byUser.get(userId) ?? []) {
        s.language = session.language;
        s.autoTranslate = session.autoTranslate;
        send(s, { t: 'self:updated', self });
      }
      broadcast({ t: 'user:upsert', user: store.getUser(userId)! });

      // Sprache gewechselt -> offenen Kanal in der neuen Sprache nachliefern
      if (ev.patch.language && session.openChannelId) {
        const { messages: list } = store.channelHistory(session.openChannelId, null, 50);
        const missing = fillCachedTranslations(list, session.language);
        for (const m of list) {
          if (m.translation) send(session, { t: 'translation', messageId: m.id, translation: m.translation });
        }
        if (missing.length) translateInBackground(missing, session.language, userId, channelContext(session.openChannelId));

        // Umfragen stehen nicht im Nachrichtentext und blieben sonst in der
        // alten Sprache stehen, während ringsum alles gewechselt hat.
        for (const m of list) {
          if (!m.poll) continue;
          void pollUebersetzungNachreichen(m.poll.id, userId, session.openChannelId);
        }
      }

      // Dasselbe für die Kanäle selbst — Name, Thema, Zweck.
      if (ev.patch.language) {
        for (const kanal of store.visibleChannels(userId)) {
          if (kanal.kind === 'dm') continue;
          void kanalUebersetzungNachreichen(kanal.id, userId);
        }
      }
      return;
    }

    case 'translate:request': {
      if (!darf(session, 'ai.translate')) return;
      if (!darfNachrichtSehen(userId, ev.messageId)) {
        return fail(session, 'fehler.keinNachrichtZugang', 'Zu dieser Nachricht hast du keinen Zugang.');
      }
      if (klartextNoetigFuerNachricht(session, ev.messageId)) return;
      const view = await translateMessage(ev.messageId, ev.targetLang, { force: ev.force });
      if (view) send(session, { t: 'translation', messageId: ev.messageId, translation: view });
      else fail(session, 'fehler.keineUebersetzungNoetig', 'Keine Übersetzung nötig oder möglich');
      return;
    }

    case 'translate:roundtrip': {
      if (!darf(session, 'ai.translate')) return;
      if (!darfNachrichtSehen(userId, ev.messageId)) {
        return fail(session, 'fehler.keinNachrichtZugang', 'Zu dieser Nachricht hast du keinen Zugang.');
      }
      if (klartextNoetigFuerNachricht(session, ev.messageId)) return;
      const result = await roundTrip(ev.messageId, ev.targetLang);
      if (!result) return fail(session, 'fehler.keineUebersetzungDa', 'Für diese Nachricht liegt keine Übersetzung vor');
      send(session, { t: 'roundtrip', messageId: ev.messageId, targetLang: ev.targetLang, ...result });
      return;
    }

    case 'compose:preview': {
      if (!darf(session, 'ai.translate')) return;
      /* Besonders wichtig hier: die Vorschau schickt Text, den die Person
         gerade erst tippt — noch unverschlüsselt, weil sie ihn ja noch nicht
         abgeschickt hat. Ginge das durch, wäre die ganze Verschlüsselung
         umsonst: der Klartext läge beim Übersetzungsdienst, bevor er den
         Kanal überhaupt erreicht. */
      if (!kanalZugang(session, ev.channelId, ev.requestId)) return;
      if (klartextNoetig(session, ev.channelId)) return;
      const outcome = await translate({
        text: ev.text, targetLang: ev.targetLang, context: channelContext(ev.channelId),
      });
      send(session, {
        t: 'compose:preview', requestId: ev.requestId,
        text: outcome.text, targetLang: ev.targetLang, sourceLang: outcome.sourceLang,
      });
      return;
    }

    case 'ai:catchup': {
      if (!darf(session, 'ai.assistant')) return;
      /* Zugang vor allem anderen: erst danach darf überhaupt herauskommen,
         ob es diesen Kanal gibt und ob er vertraulich ist. */
      if (!kanalZugang(session, ev.channelId, ev.requestId)) return;
      if (klartextNoetig(session, ev.channelId)) return;
      const ch = store.getChannel(ev.channelId, userId);
      if (!ch) return fail(session, 'fehler.kanalNichtGefunden', 'Kanal nicht gefunden', ev.requestId);
      const state = store.channelState(ev.channelId, userId);
      const summary = await ai.catchUp({
        channelId: ev.channelId,
        sinceMessageId: ev.sinceMessageId ?? state?.lastReadMessageId ?? null,
        language: session.language,
        channelName: channels.channelLabel(ch, userId, (id) => store.getUser(id)?.displayName ?? 'Unbekannt'),
        fuerUserId: userId,
      });
      send(session, { t: 'ai:catchup', requestId: ev.requestId, summary });
      return;
    }

    case 'ai:thread-summary': {
      if (!darf(session, 'ai.assistant')) return;
      /* Ohne diese Prüfung ließe sich jeder Thread zusammenfassen, dessen
         Kennung man kennt — auch aus einem Kanal, in dem man nichts verloren
         hat. Die Zusammenfassung gäbe den Inhalt dann wieder. */
      if (!darfNachrichtSehen(userId, ev.messageId)) {
        return fail(session, 'fehler.nachrichtNichtGefunden', 'Nachricht nicht gefunden', ev.requestId);
      }
      if (klartextNoetigFuerNachricht(session, ev.messageId)) return;
      const summary = await ai.summarizeThread(ev.messageId, session.language);
      send(session, { t: 'ai:thread-summary', requestId: ev.requestId, messageId: ev.messageId, summary });
      return;
    }

    case 'ai:smart-replies': {
      if (!darf(session, 'ai.assistant')) return;
      // Vorschläge entstehen aus dem Verlauf — also nur, wo man mitliest.
      if (!kanalZugang(session, ev.channelId, ev.requestId)) return;
      if (klartextNoetig(session, ev.channelId)) return;
      const self = store.getSelf(userId)!;
      const replies = await ai.smartReplies({
        channelId: ev.channelId, parentId: ev.parentId ?? null,
        language: session.language, selfName: self.displayName,
      });
      send(session, { t: 'ai:smart-replies', requestId: ev.requestId, replies });
      return;
    }

    case 'ai:rewrite': {
      if (!darf(session, 'ai.assistant')) return;
      /* channelId dient hier nur der Vertraulichkeitsprüfung; wer einen
         fremden Kanal angibt, soll aber auch nicht erfahren, ob er
         vertraulich ist. */
      if (ev.channelId && !kanalZugang(session, ev.channelId, ev.requestId)) return;
      if (klartextNoetig(session, ev.channelId)) return;
      const text = await ai.rewrite({ text: ev.text, tone: ev.tone, targetLang: ev.targetLang ?? null });
      send(session, { t: 'ai:rewrite', requestId: ev.requestId, text });
      return;
    }

    /* ── Umfragen ─────────────────────────────────────────── */

    case 'poll:create': {
      if (!darf(session, 'poll.create')) return;
      const ch = store.getChannel(ev.channelId, userId);
      if (!ch) return fail(session, 'fehler.kanalNichtGefunden', 'Kanal nicht gefunden');
      if (ch.kind !== 'public' && !store.isMember(ch.id, userId)) {
        return fail(session, 'fehler.keinKanalZugriff', 'Kein Zugriff auf diesen Kanal');
      }

      /* Die Frage wird zum Nachrichtentext, die Antwortmöglichkeiten landen in
         poll_options — beides also im Kanal und in der Datenbank, beides mit
         derselben Zusage wie eine gewöhnliche Nachricht. Geprüft wird alles
         zusammen: eine Umfrage, bei der nur die Frage verschlossen ist, gibt
         ihren Gegenstand über die Antworten preis. */
      if (chiffratNoetig(session, ch.id, [ev.question, ...ev.options])) return;

      const msg = messages.createMessage({
        channelId: ch.id, userId, text: ev.question.trim(),
        parentId: ev.parentId ?? null, kind: 'poll',
      });
      polls.createPoll({
        messageId: msg.id, question: ev.question, options: ev.options,
        multiple: ev.multiple, anonymous: ev.anonymous, closesAt: ev.closesAt ?? null, userId,
      });
      // Neu laden, damit die Umfrage dranhängt.
      deliverMessage(store.getMessage(msg.id, userId)!, ev.clientId);
      return;
    }

    case 'poll:vote': {
      // Eine Umfrage hängt an einer Nachricht — wer die nicht sehen darf,
      // stimmt auch nicht mit ab.
      const zugehoerig = database.get<{ message_id: string }>(
        'SELECT message_id FROM polls WHERE id = ?', ev.pollId,
      );
      if (!zugehoerig || !darfNachrichtSehen(userId, zugehoerig.message_id)) {
        return fail(session, 'fehler.keinUmfrageZugang', 'Zu dieser Umfrage hast du keinen Zugang.');
      }
      polls.vote(ev.pollId, userId, ev.optionIds);
      broadcastPoll(ev.pollId);
      return;
    }

    case 'poll:close': {
      polls.closePoll(ev.pollId, userId, may(userId, 'poll.close_any'));
      broadcastPoll(ev.pollId);
      return;
    }

    /* ── Weiterleiten ─────────────────────────────────────── */

    case 'message:forward': {
      if (!darf(session, 'message.forward')) return;
      const original = store.getMessage(ev.messageId, userId);
      if (!original) return fail(session, 'fehler.nachrichtNichtGefunden', 'Nachricht nicht gefunden');
      const target = store.getChannel(ev.toChannelId, userId);
      if (!target) return fail(session, 'fehler.zielkanalNichtGefunden', 'Zielkanal nicht gefunden');
      if (target.kind !== 'public' && !store.isMember(target.id, userId)) {
        return fail(session, 'fehler.keinZielkanalZugriff', 'Kein Zugriff auf den Zielkanal');
      }
      if (!store.isMember(original.channelId, userId) && store.getChannel(original.channelId)?.kind !== 'public') {
        return fail(session, 'fehler.keinUrsprungZugriff', 'Kein Zugriff auf die Ursprungsnachricht');
      }

      /* Weiterleiten und Vertraulichkeit vertragen sich in keine Richtung.
         Die vier Fälle einzeln:

           offen → offen             bleibt erlaubt, hier ist nichts zu schützen.

           offen → vertraulich       der Text käme im Klartext in einen Kanal,
                                     in dem laut Zusage nur Chiffrat liegt. Er
                                     stünde dort für den Server lesbar — und
                                     zwar dauerhaft, während alle daneben
                                     stehenden Nachrichten verschlossen sind.

           vertraulich → offen       das Chiffrat verließe den Kanal. Lesen
                                     kann es im Zielkanal niemand, aber es
                                     liegt ab dann bei Leuten, die nie dabei
                                     waren — und wer später an den Schlüssel
                                     kommt, über ein Gerät oder eine Freigabe,
                                     liest es nachträglich mit. Umwandeln kann
                                     der Server es nicht: er hat den Schlüssel
                                     nicht, das ist der ganze Zweck.

           vertraulich → vertraulich zwei Kanäle, zwei Kanalschlüssel. Das
                                     Chiffrat des einen ist im anderen wertlos,
                                     und die Mitglieder dort sähen einen Block
                                     Zeichen, den sie für einen Fehler halten.

         Ein Weiterleiten, das wirklich funktioniert, müsste die App erledigen:
         entschlüsseln, mit dem Schlüssel des Zielkanals neu verschlüsseln und
         als gewöhnliche Nachricht senden. Dem Protokoll fehlt dafür das Feld,
         und der Server kann diesen Schritt nicht übernehmen. Bis dahin also
         nein — mit eigener Kennung und eigenem Text, denn "bitte aktualisieren"
         wäre hier gelogen: kein Stand dieser App kann das.

         Der Text der Nachricht wird zusätzlich geprüft, nicht nur die beiden
         Kanäle. Ein Kanal lässt sich abschalten (vertraulich.ausschalten), die
         alten Nachrichten darin bleiben verschlüsselt — ohne diese Prüfung
         ließe sich ein solches Chiffrat danach überallhin verteilen. */
      if (vertraulich.istVertraulich(original.channelId)
        || vertraulich.istVertraulich(target.id)
        || istE2EChiffrat(original.text)) {
        return fail(session, 'fehler.vertraulichWeiterleiten',
          'Aus einem vertraulichen Kanal heraus und in einen hinein lässt sich nichts weiterleiten — '
          + 'jeder vertrauliche Kanal hat seinen eigenen Schlüssel, und offener Text gehört nicht hinein.');
      }

      const text = [ev.comment?.trim(), original.text].filter(Boolean).join('\n\n');
      const msg = messages.createMessage({
        channelId: target.id, userId, text,
        forwardedFrom: `${original.id}|${original.channelId}|${original.userId}`,
      });
      deliverMessage(msg, ev.clientId);
      enrichLinks(msg.id, msg.text, target.id);
      return;
    }

    /* ── Erinnerungen ─────────────────────────────────────── */

    case 'reminder:create': {
      /* Der Zeitgeber schickt beim Auslösen die ganze Nachricht mit (siehe
         startBackgroundJobs). Ohne diese beiden Zeilen genügte eine bekannte
         Kennung, um sich den Text einer fremden Nachricht zustellen zu
         lassen — mit fünf Sekunden Verzögerung und ganz ohne Mitgliedschaft. */
      if (!kanalZugang(session, ev.channelId)) return;
      if (ev.messageId && !darfNachrichtLesen(userId, ev.messageId)) {
        return fail(session, 'fehler.keinNachrichtZugang', 'Zu dieser Nachricht hast du keinen Zugang.');
      }
      const reminder = reminders.createReminder({
        userId, channelId: ev.channelId, messageId: ev.messageId ?? null,
        note: ev.note ?? null, remindAt: ev.remindAt,
      });
      send(session, { t: 'reminder:upsert', reminder });
      return;
    }

    case 'reminder:cancel':
      if (reminders.cancel(ev.reminderId, userId)) {
        sendToUser(userId, { t: 'reminder:removed', reminderId: ev.reminderId });
      }
      return;

    case 'reminder:done':
      if (reminders.markDone(ev.reminderId, userId)) {
        sendToUser(userId, { t: 'reminder:removed', reminderId: ev.reminderId });
      }
      return;

    /* ── Entwürfe ─────────────────────────────────────────── */

    case 'draft:save':
      /* Ein Entwurf für einen vertraulichen Kanal bleibt auf dem Gerät.
         Sonst wäre die ganze Verschlüsselung umsonst: die App speichert beim
         Tippen mit, also käme jede Nachricht schon vor dem Absenden Zeichen
         für Zeichen offen auf dem Server an — und bliebe dort liegen, während
         die fertige Nachricht daneben verschlossen ist.

         Abgewiesen wird hier still, nicht mit einer Fehlermeldung. Das
         Zwischenspeichern ist keine Handlung, die jemand auslöst, sondern
         läuft beim Tippen nebenher; ein Fehler dafür wäre eine Meldung pro
         Tastendruck. Dieselbe Linie wie bei enrichLinks() und
         runTranscription(): was im Hintergrund läuft und hier nicht sein darf,
         unterbleibt einfach.

         Der leere Text löscht dabei, was noch dasteht — ein Entwurf aus der
         Zeit vor der Umstellung soll nicht liegen bleiben. */
      if (vertraulich.istVertraulich(ev.channelId) && !istE2EChiffrat(ev.text)) {
        drafts.saveDraft(userId, ev.channelId, ev.parentId ?? null, '');
        return;
      }
      drafts.saveDraft(userId, ev.channelId, ev.parentId ?? null, ev.text);
      return;

    /* ── Sprachnachrichten ────────────────────────────────── */

    case 'voice:send': {
      if (!darf(session, 'voice.send')) return;
      const ch = store.getChannel(ev.channelId, userId);
      if (!ch) return fail(session, 'fehler.kanalNichtGefunden', 'Kanal nicht gefunden');
      if (ch.kind !== 'public' && !store.isMember(ch.id, userId)) {
        return fail(session, 'fehler.keinKanalZugriff', 'Kein Zugriff auf diesen Kanal');
      }
      /* Sprachnachrichten gibt es in einem vertraulichen Kanal nicht.
         Anders als beim Tippen liegt es hier nicht an der App: die Aufnahme
         geht als Anhang über dieselbe Ablage wie jede andere Datei, und für
         Anhänge gibt es die Ende-zu-Ende-Verschlüsselung noch nicht. Der
         Inhalt läge also anhörbar auf dem Server — genau das, was dieser Kanal
         ausschließt. Das Transkript unterbleibt schon länger (siehe
         runTranscription), aber die Aufnahme selbst bliebe liegen, und die ist
         der eigentliche Inhalt.

         Deshalb eine eigene Kennung: "bitte aktualisieren" verspräche, dass
         eine neuere App das könnte. Kann sie nicht — dafür müssten zuerst die
         Anhänge verschlüsselt werden. */
      if (ch.vertraulich) {
        return fail(session, 'fehler.vertraulichSprachnachricht',
          'In einem vertraulichen Kanal gibt es keine Sprachnachrichten — '
          + 'die Aufnahme läge unverschlüsselt auf dem Server.');
      }

      const msg = messages.createMessage({
        channelId: ch.id, userId, text: '🎙️ Sprachnachricht',
        parentId: ev.parentId ?? null, attachmentIds: [ev.attachmentId], kind: 'voice',
      });
      messages.markRead(ch.id, userId, msg.id);
      deliverMessage(msg, ev.clientId);
      void runTranscription(msg.id, ev.attachmentId).catch((err) => console.error('[ws] Umschrift:', (err as Error).message));
      return;
    }

    /* ── KI als Gesprächspartner ──────────────────────────── */

    case 'ai:open-chat': {
      if (!darf(session, 'ai.assistant')) return;
      const channelId = ki.openPrivateChat(userId);
      const ch = store.getChannel(channelId, userId)!;
      send(session, { t: 'channel:upsert', channel: ch });
      const st = store.channelState(channelId, userId);
      if (st) send(session, { t: 'channel:state', state: st });
      session.openChannelId = channelId;
      const { messages: list, hasMore } = store.channelHistory(channelId, null, 50, userId);
      send(session, { t: 'channel:history', channelId, messages: list, hasMore });
      // Ohne diese Zeile lädt der Kanal im Hintergrund und die Ansicht bleibt,
      // wo sie war — der Klick sähe aus, als hätte er nichts bewirkt.
      send(session, { t: 'channel:focus', channelId });
      return;
    }

    case 'ai:open-team-channel': {
      if (!darf(session, 'ai.assistant')) return;
      const self = store.getSelf(userId);
      const channelId = ki.ensureTeamChannel(self?.id ?? userId);
      channels.ensureMember(channelId, userId);
      const ch = store.getChannel(channelId, userId)!;
      broadcast({ t: 'channel:upsert', channel: ch });
      const zustand = store.channelState(channelId, userId);
      if (zustand) send(session, { t: 'channel:state', state: zustand });
      session.openChannelId = channelId;
      const { messages: list, hasMore } = store.channelHistory(channelId, null, 50, userId);
      send(session, { t: 'channel:history', channelId, messages: list, hasMore });
      send(session, { t: 'channel:focus', channelId });
      return;
    }

    case 'ai:set-mode': {
      if (!darf(session, 'channel.manage')) return;
      /* Den Assistenten in einem vertraulichen Kanal einzuschalten geht nicht.
         Er bekäme nur Chiffrat zu sehen — und die Einstellung stünde dann als
         eingeschaltet da, während nie etwas passiert. */
      if (klartextNoetig(session, ev.channelId)) return;
      ki.setAiMode(ev.channelId, ev.mode);
      const ch = store.getChannel(ev.channelId, userId);
      if (ch) broadcast({ t: 'channel:upsert', channel: ch }, ch.kind === 'public' ? undefined : ch.memberIds);
      return;
    }

    /* ── Aufgaben ─────────────────────────────────────────── */

    case 'task:list':
      send(session, {
        t: 'task:list',
        tasks: tasks.listTasks({
          channelId: ev.channelId, assigneeId: ev.assigneeId, sichtbarFuer: userId,
        }),
      });
      return;

    case 'task:create': {
      if (!darf(session, 'task.create')) return;
      if (ev.assigneeId && ev.assigneeId !== userId && !may(userId, 'task.assign')) {
        return fail(session, 'fehler.keinRechtUebergeben', 'Aufgaben an andere zu übergeben ist ein eigenes Recht.');
      }
      /* An einen Kanal hängen darf sie nur, wer den Kanal auch sieht. Sonst
         ließe sich eine Aufgabe in einem fremden privaten Kanal ablegen — und
         nachher fragen, was aus ihr geworden ist. */
      if (ev.channelId && !kanalZugang(session, ev.channelId)) return;
      const task = tasks.createTask({ ...ev, createdBy: userId });
      // Alle Beteiligten sollen die Aufgabe sofort sehen.
      broadcastTask(task);
      return;
    }

    case 'task:update': {
      if (!darf(session, 'task.create')) return;
      const vorher = tasks.getTask(ev.taskId);
      if (!vorher) return fail(session, 'fehler.aufgabeNichtGefunden', 'Aufgabe nicht gefunden.');
      if (!aufgabeSichtbar(session, vorher)) return;
      if (ev.patch.assigneeId !== undefined && ev.patch.assigneeId !== userId && !may(userId, 'task.assign')) {
        return fail(session, 'fehler.keinRechtUebergeben', 'Aufgaben an andere zu übergeben ist ein eigenes Recht.');
      }
      /* Das Protokoll kennt in diesem Feld keinen Kanalwechsel — der Dienst
         schon, und ein selbstgebauter Client schickt, was er will. Wer eine
         Aufgabe umhängt, muss beide Kanäle sehen dürfen. */
      const zielKanal = (ev.patch as { channelId?: string | null }).channelId;
      if (zielKanal && !kanalZugang(session, zielKanal)) return;
      umzugMelden(vorher, tasks.updateTask(ev.taskId, ev.patch, userId));
      return;
    }

    case 'task:move': {
      if (!darf(session, 'task.create')) return;
      const vorher = tasks.getTask(ev.taskId);
      if (!vorher) return fail(session, 'fehler.aufgabeNichtGefunden', 'Aufgabe nicht gefunden.');
      if (!aufgabeSichtbar(session, vorher)) return;
      broadcastTask(tasks.reorder(ev.taskId, ev.status, ev.afterId ?? null, userId));
      return;
    }

    case 'task:comment': {
      const ziel = tasks.getTask(ev.taskId);
      if (!ziel) return fail(session, 'fehler.aufgabeNichtGefunden', 'Aufgabe nicht gefunden.');
      if (!aufgabeSichtbar(session, ziel)) return;
      const verlauf = tasks.addComment(ev.taskId, userId, ev.text);
      send(session, { t: 'task:history', taskId: ev.taskId, events: verlauf });
      const task = tasks.getTask(ev.taskId);
      if (task) broadcastTask(task);
      return;
    }

    case 'task:watch': {
      const ziel = tasks.getTask(ev.taskId);
      if (!ziel) return fail(session, 'fehler.aufgabeNichtGefunden', 'Aufgabe nicht gefunden.');
      if (!aufgabeSichtbar(session, ziel)) return;
      broadcastTask(tasks.setWatching(ev.taskId, userId, ev.watching));
      return;
    }

    case 'task:delete': {
      const task = tasks.getTask(ev.taskId);
      if (!task) return;
      if (!aufgabeSichtbar(session, task)) return;
      const eigene = task.createdBy === userId;
      if (!eigene && !may(userId, 'task.delete')) {
        return fail(session, 'fehler.nurModerationAufgaben', 'Fremde Aufgaben darf nur die Moderation löschen.');
      }
      tasks.deleteTask(ev.taskId);
      // Der Kreis muss vor dem Löschen feststehen — danach ist die Zeile weg.
      broadcast({ t: 'task:removed', taskId: ev.taskId }, empfaengerFuer(task.channelId));
      return;
    }

    case 'task:history': {
      /* Der Verlauf trägt Titel, Kommentare und wer was geändert hat. Ohne
         diese Prüfung nützte die gefilterte Liste nichts: man müsste die
         Kennung nur kennen und direkt hier fragen. */
      const ziel = tasks.getTask(ev.taskId);
      if (!ziel) return fail(session, 'fehler.aufgabeNichtGefunden', 'Aufgabe nicht gefunden.');
      if (!aufgabeSichtbar(session, ziel)) return;
      send(session, { t: 'task:history', taskId: ev.taskId, events: tasks.historyOf(ev.taskId) });
      return;
    }

    /* ── Vorschlagseingang ─────────────────────────────────────

       Ein Vorschlag gehört genau einer Person. Der Empfängerkreis ist
       deshalb nicht `broadcast(..., empfaengerFuer(...))`, sondern die eine
       Person — aber erst, nachdem `vorschlagSichtbar()` bestätigt hat, dass
       sie den Kanal noch sehen darf. Was daraus entsteht, geht dagegen an
       den vollen Kanalkreis: eine angenommene Aufgabe gehört dem Kanal. */

    case 'vorschlag:list': {
      send(session, { t: 'vorschlag:list', vorschlaege: vorschlaege.listeFuer(userId) });
      return;
    }

    case 'vorschlag:accept': {
      if (!vorschlagSichtbar(session, ev.vorschlagId, ev.requestId)) return;
      try {
        const { vorschlag, aufgabe, idee } = vorschlaege.annehmen(ev.vorschlagId, userId, ev.aenderung);
        /* Erst das Entstandene an den Kanalkreis, dann die Quittung an den
           einen Wartenden: so steht die Aufgabe schon auf dem Brett, wenn
           der Eingang sie als angenommen meldet. */
        if (aufgabe) broadcast({ t: 'task:upsert', task: aufgabe }, empfaengerFuer(aufgabe.channelId));
        if (idee) broadcast({ t: 'idea:upsert', idea: idee }, empfaengerFuer(idee.channelId));
        sendToUser(userId, { t: 'vorschlag:upsert', requestId: ev.requestId, vorschlag });
      } catch (e) {
        return vorschlagFehler(session, e, ev.requestId);
      }
      return;
    }

    case 'vorschlag:reject': {
      if (!vorschlagSichtbar(session, ev.vorschlagId, ev.requestId)) return;
      try {
        const vorschlag = vorschlaege.ablehnen(ev.vorschlagId, userId);
        sendToUser(userId, { t: 'vorschlag:upsert', requestId: ev.requestId, vorschlag });
      } catch (e) {
        return vorschlagFehler(session, e, ev.requestId);
      }
      return;
    }

    case 'vorschlag:undo': {
      if (!vorschlagSichtbar(session, ev.vorschlagId, ev.requestId)) return;
      try {
        const vorher = vorschlaege.getVorschlag(ev.vorschlagId);
        const vorschlag = vorschlaege.zuruecknehmen(ev.vorschlagId, userId);
        /* Das Entstandene ist weg — sonst bliebe die Aufgabe auf den
           Brettern aller anderen stehen, bis jemand neu lädt. */
        if (vorher?.ergebnisId) {
          const kreis = empfaengerFuer(vorschlag.channelId);
          if (vorher.art === 'aufgabe') broadcast({ t: 'task:removed', taskId: vorher.ergebnisId }, kreis);
          else broadcast({ t: 'idea:removed', ideaId: vorher.ergebnisId }, kreis);
        }
        sendToUser(userId, { t: 'vorschlag:upsert', requestId: ev.requestId, vorschlag });
      } catch (e) {
        return vorschlagFehler(session, e, ev.requestId);
      }
      return;
    }

    case 'ai:extract-tasks': {
      if (!darf(session, 'ai.assistant')) return;
      // Aufgaben entstehen aus dem Verlauf des Kanals — nur aus einem eigenen.
      if (!kanalZugang(session, ev.channelId, ev.requestId)) return;
      if (klartextNoetig(session, ev.channelId)) return;
      /* Nur das Neue seit dem letzten Durchgang ansehen. */
      const marke = `aufgaben_ab:${ev.channelId}`;
      const seit = settings.getSetting(marke);
      const gefunden = await ai.extractTasks({
        channelId: ev.channelId,
        language: session.language,
        sinceMessageId: seit,
      });
      const neuste = database.get<{ id: string }>(
        'SELECT id FROM messages WHERE channel_id = ? ORDER BY created_at DESC LIMIT 1', ev.channelId,
      )?.id;

      /* Der Knopf legt nichts mehr an, er füllt den Eingang.
         Vorher entstanden die Aufgaben sofort auf dem Brett — wer drückte,
         fand hinterher fünf Karten, von denen zwei stimmten. Jetzt geht
         beides denselben Weg: was von Hand angestoßen wird und was der
         Hintergrundlauf findet, landet als Vorschlag und wartet auf ein Ja.
         Der Abdruck im Dienst sorgt dafür, dass ein Titel, den der
         Hintergrundlauf schon vorgeschlagen hat, hier als Dublette zählt
         statt zweimal im Eingang zu liegen. */
      const bericht = vorschlaege.kandidatenEintragen(
        ev.channelId,
        gefunden.map((g) => ({
          art: 'aufgabe' as const,
          titel: g.title,
          quelleMessageId: null,
          genanntUserId: g.assigneeId,
          faelligAm: g.dueAt,
        })),
      );
      for (const v of bericht.angelegt) {
        if (darfElementSehen(v.fuerUserId, v.channelId)) {
          sendToUser(v.fuerUserId, { t: 'vorschlag:neu', vorschlag: v });
        }
      }

      // Erst nach dem Eintragen merken — bricht etwas ab, wird beim nächsten
      // Mal derselbe Abschnitt noch einmal gelesen statt übersprungen.
      if (neuste) settings.setSetting(marke, neuste, userId);

      send(session, {
        t: 'ai:extract-tasks', requestId: ev.requestId,
        tasks: gefunden,
        vorgeschlagen: bericht.angelegt.length,
        uebersprungen: bericht.dubletten + bericht.ohneAdressat,
      });
      return;
    }

    case 'ai:protocol': {
      if (!darf(session, 'ai.assistant')) return;
      if (!kanalZugang(session, ev.channelId)) return;
      if (klartextNoetig(session, ev.channelId)) return;
      const kanal = store.getChannel(ev.channelId, userId);
      if (!kanal) return fail(session, 'fehler.kanalNichtGefunden', 'Kanal nicht gefunden.');
      send(session, {
        t: 'ai:protocol',
        protocol: await ai.protokoll({
          channelId: ev.channelId,
          channelName: kanal.name,
          language: session.language,
          sinceMessageId: ev.sinceMessageId ?? null,
        }),
      });
      return;
    }

    /* ── Kalender ─────────────────────────────────────────── */

    case 'event:list':
      send(session, { t: 'event:list', events: events.listEvents(ev.from, ev.to, userId) });
      return;

    case 'event:create': {
      if (!darf(session, 'event.create')) return;
      if (ev.channelId && !kanalZugang(session, ev.channelId)) return;
      const termin = events.createEvent({ ...ev, createdBy: userId });
      broadcastTermin(termin);
      return;
    }

    case 'event:update': {
      const termin = events.getEvent(ev.eventId);
      if (!termin) return fail(session, 'fehler.terminNichtGefunden', 'Termin nicht gefunden.');
      if (!terminSichtbar(session, termin)) return;
      if (termin.createdBy !== userId && !may(userId, 'event.manage')) {
        return fail(session, 'fehler.nurVerwaltungTermine', 'Fremde Termine darf nur die Verwaltung ändern.');
      }
      broadcastTermin(events.updateEvent(ev.eventId, ev.patch));
      return;
    }

    case 'event:respond': {
      /* Zusagen ohne den Termin sehen zu dürfen ginge sonst — und mit der
         Zusage stünde man in der Teilnehmerliste eines Termins, von dem man
         nichts wissen sollte. */
      const termin = events.getEvent(ev.eventId);
      if (!termin) return fail(session, 'fehler.terminNichtGefunden', 'Termin nicht gefunden.');
      if (!terminSichtbar(session, termin)) return;
      broadcastTermin(events.respond(ev.eventId, userId, ev.response));
      return;
    }

    case 'event:attendees': {
      const termin = events.getEvent(ev.eventId);
      if (!termin) return;
      if (!terminSichtbar(session, termin)) return;
      if (termin.createdBy !== userId && !may(userId, 'event.manage')) {
        return fail(session, 'fehler.nurEinladerTeilnehmende', 'Nur wer eingeladen hat, ändert die Teilnehmenden.');
      }
      broadcastTermin(events.setAttendees(ev.eventId, ev.add, ev.remove));
      return;
    }

    case 'event:delete': {
      const termin = events.getEvent(ev.eventId);
      if (!termin) return;
      if (!terminSichtbar(session, termin)) return;
      if (termin.createdBy !== userId && !may(userId, 'event.manage')) {
        return fail(session, 'fehler.nurVerwaltungTermineLoeschen', 'Fremde Termine darf nur die Verwaltung löschen.');
      }
      events.deleteEvent(ev.eventId);
      broadcast({ t: 'event:removed', eventId: ev.eventId }, empfaengerFuer(termin.channelId));
      return;
    }

    /* ── Ideenboard ───────────────────────────────────────── */

    case 'idea:list':
      send(session, { t: 'idea:list', ideas: ideas.listIdeas(userId) });
      return;

    case 'idea:create': {
      if (!darf(session, 'idea.create')) return;
      if (ev.channelId && !kanalZugang(session, ev.channelId)) return;
      broadcastIdee(ideas.createIdea({ ...ev, createdBy: userId }));
      return;
    }

    case 'idea:update': {
      const idee = ideas.getIdea(ev.ideaId, userId);
      if (!idee) return fail(session, 'fehler.ideeNichtGefunden', 'Idee nicht gefunden.');
      if (!ideeSichtbar(session, idee)) return;
      if (idee.createdBy !== userId && !may(userId, 'idea.manage')) {
        return fail(session, 'fehler.nurModerationIdeen', 'Fremde Ideen darf nur die Moderation ändern.');
      }
      // Anders als bei Aufgaben kennt das Protokoll den Kanalwechsel hier
      // ausdrücklich — er braucht denselben Zugang wie das Anlegen.
      if (ev.patch.channelId && !kanalZugang(session, ev.patch.channelId)) return;
      ideenUmzugMelden(idee.channelId, ideas.updateIdea(ev.ideaId, ev.patch, userId));
      return;
    }

    case 'idea:status': {
      if (!darf(session, 'idea.manage')) return;
      const idee = ideas.getIdea(ev.ideaId, userId);
      if (!idee) return fail(session, 'fehler.ideeNichtGefunden', 'Idee nicht gefunden.');
      if (!ideeSichtbar(session, idee)) return;
      broadcastIdee(ideas.setStatus(ev.ideaId, ev.status, userId, ev.decision));
      return;
    }

    case 'idea:vote': {
      if (!darf(session, 'idea.vote')) return;
      const idee = ideas.getIdea(ev.ideaId, userId);
      if (!idee) return fail(session, 'fehler.ideeNichtGefunden', 'Idee nicht gefunden.');
      if (!ideeSichtbar(session, idee)) return;
      ideas.vote(ev.ideaId, userId, ev.wert);
      // Die eigene Stimme steckt in der Antwort — jede Person bekommt daher
      // ihre eigene Sicht auf dieselbe Idee. broadcastIdee() macht genau das
      // und hält sich dabei an den Kreis des Kanals.
      broadcastIdee(ideas.getIdea(ev.ideaId, userId));
      return;
    }

    case 'idea:comments': {
      const idee = ideas.getIdea(ev.ideaId, userId);
      if (!idee) return fail(session, 'fehler.ideeNichtGefunden', 'Idee nicht gefunden.');
      if (!ideeSichtbar(session, idee)) return;
      send(session, { t: 'idea:comments', ideaId: ev.ideaId, comments: ideas.comments(ev.ideaId) });
      return;
    }

    case 'idea:comment': {
      if (!darf(session, 'message.send')) return;
      const idee = ideas.getIdea(ev.ideaId, userId);
      if (!idee) return fail(session, 'fehler.ideeNichtGefunden', 'Idee nicht gefunden.');
      if (!ideeSichtbar(session, idee)) return;
      const liste = ideas.addComment(ev.ideaId, userId, ev.text);
      broadcast({ t: 'idea:comments', ideaId: ev.ideaId, comments: liste }, empfaengerFuer(idee.channelId));
      broadcastIdee(ideas.getIdea(ev.ideaId, userId));
      return;
    }

    case 'idea:comment-delete': {
      /* Die Kennung der Idee kommt vom Client und muss nicht zum Kommentar
         gehören — geprüft wird deshalb die Idee, deren Kommentare gleich
         herausgehen. */
      const idee = ideas.getIdea(ev.ideaId, userId);
      if (!idee) return fail(session, 'fehler.ideeNichtGefunden', 'Idee nicht gefunden.');
      if (!ideeSichtbar(session, idee)) return;
      ideas.deleteComment(ev.commentId, userId, may(userId, 'idea.manage'));
      broadcast({ t: 'idea:comments', ideaId: ev.ideaId, comments: ideas.comments(ev.ideaId) },
        empfaengerFuer(idee.channelId));
      return;
    }

    case 'idea:delete': {
      const idee = ideas.getIdea(ev.ideaId, userId);
      if (!idee) return;
      if (!ideeSichtbar(session, idee)) return;
      if (idee.createdBy !== userId && !may(userId, 'idea.manage')) {
        return fail(session, 'fehler.nurModerationIdeenLoeschen', 'Fremde Ideen darf nur die Moderation löschen.');
      }
      ideas.deleteIdea(ev.ideaId);
      broadcast({ t: 'idea:removed', ideaId: ev.ideaId }, empfaengerFuer(idee.channelId));
      return;
    }

    /* ── Dateiablage ──────────────────────────────────────── */

    case 'file:list':
      send(session, {
        t: 'file:list',
        // fuerUserId fehlte: ohne den Fragenden liefert dieser Weg gar keine
        // privaten Dateien — sicher, aber unvollständig, und die eigene Datei
        // im eigenen Verzeichnis nicht zu sehen ist kein Schutz, sondern ein Fehler.
        files: files.listFiles({ channelId: ev.channelId, folder: ev.folder, fuerUserId: userId }),
        usage: files.usage(),
      });
      return;

    case 'file:update': {
      const datei = files.getFile(ev.fileId);
      if (!datei) return fail(session, 'fehler.dateiNichtGefunden', 'Datei nicht gefunden.');
      if (datei.uploadedBy !== userId && !may(userId, 'file.manage')) {
        return fail(session, 'fehler.nurVerwaltungDateien', 'Fremde Dateien darf nur die Verwaltung ändern.');
      }
      const geaendert = files.updateFile(ev.fileId, ev);
      /* Eine private Datei an alle zu rufen verrät ihre Existenz und ihren
         Namen — auch wenn der Client sie hinterher wegfiltert. Was niemanden
         angeht, wird gar nicht erst verschickt. */
      if (geaendert.privat) sendToUser(geaendert.uploadedBy, { t: 'file:upsert', file: geaendert });
      else broadcast({ t: 'file:upsert', file: geaendert });
      return;
    }

    case 'file:delete': {
      const datei = files.getFile(ev.fileId);
      if (!datei) return;
      if (datei.uploadedBy !== userId && !may(userId, 'file.manage')) {
        return fail(session, 'fehler.nurVerwaltungDateienLoeschen', 'Fremde Dateien darf nur die Verwaltung löschen.');
      }
      files.deleteFile(ev.fileId);
      broadcast({ t: 'file:removed', fileId: ev.fileId });
      return;
    }

    case 'voice:retranscribe': {
      /* Dieselbe Prüfung wie bei 'translate:request' und 'thread:open'. Sie
         fehlte hier als einziger Stelle, und das war nicht folgenlos: die
         Abschrift wird zum Nachrichtentext (siehe runTranscription), also
         ließ sich mit einer bekannten Kennung eine fremde Nachricht in einem
         Kanal umschreiben, den man nie gesehen hat. */
      if (!darfNachrichtLesen(userId, ev.messageId)) {
        return fail(session, 'fehler.keinNachrichtZugang', 'Zu dieser Nachricht hast du keinen Zugang.');
      }
      const voice = voiceNoteFor(ev.messageId);
      if (!voice) return fail(session, 'fehler.keineAufnahme', 'Keine Aufnahme an dieser Nachricht');
      void runTranscription(ev.messageId, voice.attachmentId).catch((err) => console.error('[ws] Umschrift:', (err as Error).message));
      return;
    }

    case 'ai:ask': {
      if (!darf(session, 'ai.assistant')) return;
      if (!kanalZugang(session, ev.channelId, ev.requestId)) return;
      if (klartextNoetig(session, ev.channelId)) return;
      const ch = store.getChannel(ev.channelId, userId);
      if (!ch) return fail(session, 'fehler.kanalNichtGefunden', 'Kanal nicht gefunden', ev.requestId);
      const result = await ai.askChannel({
        channelId: ev.channelId, question: ev.question, language: session.language,
        channelName: channels.channelLabel(ch, userId, (id) => store.getUser(id)?.displayName ?? 'Unbekannt'),
      });
      send(session, { t: 'ai:ask', requestId: ev.requestId, ...result });
      return;
    }

    /* ── Vertrauliche Kanäle ────────────────────────────────
       Der Server nimmt hier Verschlossenes entgegen und gibt Verschlossenes
       heraus. Was er prüft, ist ausschließlich, wer wem etwas geben darf —
       nie, was darin steht. */

    case 'vertraulich:schluessel-melden': {
      if (!ev.jwk || !ev.abdruck) return fail(session, 'fehler.schluesselUnvollstaendig', 'Der Schlüssel ist unvollständig.');
      if (ev.jwk.length > 4000) return fail(session, 'fehler.schluesselZuGross', 'Der Schlüssel ist zu groß.');
      const ergebnis = vertraulich.schluesselMelden({
        userId, jwk: ev.jwk, abdruck: ev.abdruck, sicherung: ev.sicherung ?? null,
      });
      send(session, { t: 'vertraulich:schluessel', schluessel: vertraulich.oeffentlicheSchluessel([userId]) });
      /* Ein neu hinterlegter Schlüssel heißt: in jedem vertraulichen Kanal
         dieser Person fehlt jetzt ein Paket. Ohne diesen Anstoß säße sie in
         ihren eigenen Kanälen vor lauter unlesbaren Nachrichten und wüsste
         nicht, warum. */
      if (ergebnis.neu || ergebnis.gewechselt) {
        for (const kanal of store.visibleChannels(userId)) {
          if (kanal.vertraulich) schluesselarbeitAnstossen(kanal.id);
        }
      }
      return;
    }

    case 'vertraulich:schluessel-holen': {
      /* Öffentliche Teile sind öffentlich — für alle Konten abrufbar, nicht
         nur für Kanalmitglieder. Sie sind zum Verteilen da, und wer sie
         einschränkte, verhinderte nur, dass man jemanden in einen
         vertraulichen Kanal aufnehmen kann, mit dem man noch keinen teilt. */
      send(session, { t: 'vertraulich:schluessel', schluessel: vertraulich.oeffentlicheSchluessel(ev.userIds) });
      return;
    }

    case 'vertraulich:sicherung-holen':
      send(session, { t: 'vertraulich:sicherung', paket: vertraulich.sicherungHolen(userId) });
      return;

    case 'vertraulich:einschalten': {
      if (!darf(session, 'vertraulich.kanal')) return;
      if (!store.isMember(ev.channelId, userId)) {
        return fail(session, 'fehler.nurMitgliederVertraulich', 'Nur Mitglieder können einen Kanal vertraulich stellen.');
      }
      const fassung = vertraulich.einschalten({ channelId: ev.channelId, userId, pakete: ev.pakete ?? [] });
      const kanal = store.getChannel(ev.channelId, userId)!;
      for (const uid of kanal.memberIds) {
        sendToUser(uid, { t: 'channel:upsert', channel: store.getChannel(ev.channelId, uid)! });
      }
      /* Auch das ist eine Zugangsänderung und gehört sichtbar in den Kanal:
         ab hier lesen Übersetzung und KI nicht mehr mit, und wer ohne
         Schlüssel dasteht, soll den Grund im Verlauf finden. */
      zugangsMeldung(
        ev.channelId, userId,
        `@${store.getUser(userId)?.handle} hat diesen Kanal vertraulich gestellt — ab hier liest nur noch mit, wer den Schlüssel hat.`,
        'vertraulich.ein',
      );
      /* Sechste Sperre: was die KI aus diesem Kanal schon vorgeschlagen hat,
         verschwindet jetzt. Die Titel stammen aus Nachrichten, die ab hier
         niemand mehr im Klartext sehen soll — auch nicht rückwirkend. */
      for (const id of vorschlaege.idsImKanal(ev.channelId)) {
        for (const uid of kanal.memberIds) sendToUser(uid, { t: 'vorschlag:removed', vorschlagId: id });
      }
      vorschlaege.kanalGeschlossen(ev.channelId);
      schluesselarbeitAnstossen(ev.channelId);
      void fassung;
      return;
    }

    case 'vertraulich:pakete': {
      const anzahl = vertraulich.paketeNachreichen({
        channelId: ev.channelId, fassung: ev.fassung, vonUserId: userId, pakete: ev.pakete ?? [],
      });
      // Jedes versorgte Konto erfährt sofort davon, statt bis zum nächsten
      // Öffnen des Kanals vor unlesbaren Nachrichten zu sitzen.
      for (const eintrag of ev.pakete ?? []) {
        sendToUser(eintrag.userId, {
          t: 'vertraulich:paket', channelId: ev.channelId,
          fassung: vertraulich.aktuelleFassung(ev.channelId),
          pakete: vertraulich.paketeFuer(ev.channelId, eintrag.userId),
        });
      }
      void anzahl;
      return;
    }

    case 'vertraulich:wechseln': {
      const fassung = vertraulich.wechseln({
        channelId: ev.channelId, userId, pakete: ev.pakete ?? [],
      });
      for (const uid of store.memberIds(ev.channelId)) {
        sendToUser(uid, {
          t: 'vertraulich:paket', channelId: ev.channelId, fassung,
          pakete: vertraulich.paketeFuer(ev.channelId, uid),
        });
        sendToUser(uid, { t: 'channel:upsert', channel: store.getChannel(ev.channelId, uid)! });
      }
      schluesselarbeitAnstossen(ev.channelId);
      return;
    }

    case 'vertraulich:paket-holen': {
      if (!store.isMember(ev.channelId, userId)) {
        return fail(session, 'fehler.keinKanalZugriff', 'Kein Zugriff auf diesen Kanal');
      }
      send(session, {
        t: 'vertraulich:paket', channelId: ev.channelId,
        fassung: vertraulich.aktuelleFassung(ev.channelId),
        pakete: vertraulich.paketeFuer(ev.channelId, userId),
      });
      return;
    }

    case 'vertraulich:vorfall-melden': {
      const freigabe = vertraulich.freigabeAnlegen({
        channelId: ev.channelId, melderId: userId, grund: ev.grund,
        codeAbdruck: ev.codeAbdruck, tage: ev.tage, pakete: ev.pakete ?? [],
      });
      /* Erst die Meldung im Kanal, dann die Bestätigung an die meldende Person.
         In dieser Reihenfolge, weil die Systemnachricht der eigentliche Zweck
         ist: schlüge sie fehl, soll niemand eine Freigabe in der Hand halten,
         von der der Kanal nichts weiß. */
      zugangsMeldung(
        ev.channelId, userId,
        `@${store.getUser(userId)?.handle} hat diesen Kanal für die Verwaltung geöffnet — Grund: ${freigabe.grund}`,
        'vertraulich.freigabe',
      );
      send(session, { t: 'vertraulich:freigabe', freigabe });
      for (const uid of new Set([...store.memberIds(ev.channelId), ...vertraulich.verwaltungIds()])) {
        if (uid === userId) continue;
        sendToUser(uid, { t: 'vertraulich:freigabe', freigabe });
      }
      return;
    }

    case 'vertraulich:freigaben':
      send(session, {
        t: 'vertraulich:freigaben', channelId: ev.channelId ?? null,
        freigaben: vertraulich.freigabenFuer(userId, ev.channelId ?? null),
      });
      return;

    case 'vertraulich:freigabe-oeffnen': {
      const schluessel = vertraulich.freigabeOeffnen({
        freigabeId: ev.freigabeId, userId, codeAbdruck: ev.codeAbdruck,
      });
      send(session, { t: 'vertraulich:freigabe-schluessel', schluessel });
      /* Auch das Öffnen gehört in den Kanal. Die Freigabe selbst war schon
         sichtbar; dass jemand sie tatsächlich benutzt hat, ist die zweite
         Hälfte derselben Auskunft. */
      zugangsMeldung(
        schluessel.channelId, userId,
        `@${store.getUser(userId)?.handle} hat die Freigabe eingelöst und liest diesen Kanal jetzt mit.`,
        'vertraulich.eingeloest',
      );
      return;
    }

    case 'vertraulich:freigabe-zuruecknehmen': {
      const freigabe = vertraulich.freigabeZuruecknehmen(ev.freigabeId, userId);
      zugangsMeldung(
        freigabe.channelId, userId,
        `@${store.getUser(userId)?.handle} hat die Freigabe für die Verwaltung zurückgenommen.`,
        'vertraulich.zurueckgenommen',
      );
      for (const uid of new Set([...store.memberIds(freigabe.channelId), ...vertraulich.verwaltungIds()])) {
        sendToUser(uid, { t: 'vertraulich:freigabe', freigabe });
      }
      return;
    }
  }
}


/* ── Helfer für die neuen Funktionen ──────────────────────────── */

/** Umfrage-Stand an alle im Kanal schicken — jede:r sieht die eigene Wahl. */
function broadcastPoll(pollId: string): void {
  const row = database.get<{ message_id: string }>('SELECT message_id FROM polls WHERE id = ?', pollId);
  if (!row) return;
  const msg = database.get<{ channel_id: string }>('SELECT channel_id FROM messages WHERE id = ?', row.message_id);
  if (!msg) return;
  for (const uid of store.memberIds(msg.channel_id)) {
    const poll = polls.getPoll(pollId, uid);
    if (!poll) continue;
    sendToUser(uid, { t: 'poll:updated', poll, channelId: msg.channel_id });
    // Die Übersetzung kommt nach, sobald sie da ist — auf sie zu warten würde
    // das Ergebnis einer Abstimmung für alle anderen verzögern.
    void pollUebersetzungNachreichen(pollId, uid, msg.channel_id);
  }
}

/**
 * Name, Thema und Zweck eines Kanals in die Lesesprache bringen. Läuft im
 * Hintergrund; steht der Kanal schon in dieser Sprache, passiert nichts.
 */
async function kanalUebersetzungNachreichen(channelId: string, userId: string): Promise<void> {
  const sprache = store.getSelf(userId)?.language;
  if (!sprache) return;
  try {
    const sicht = await translateChannel(channelId, sprache);
    const kanal = store.getChannel(channelId, userId);
    if (kanal) sendToUser(userId, { t: 'channel:upsert', channel: { ...kanal, translation: sicht } });
  } catch (err) {
    console.error('[kanal]', (err as Error).message);
  }
}

/**
 * Frage und Antworten in die Lesesprache bringen und nachliefern.
 * Steht die Umfrage schon in dieser Sprache, passiert nichts.
 */
async function pollUebersetzungNachreichen(pollId: string, userId: string, channelId: string): Promise<void> {
  /* Dieselbe Grenze wie bei fillCachedTranslations(): eine verschlüsselte
     Umfrage zu übersetzen hieße, das Chiffrat an ein fremdes Modell zu
     schicken. Zurück käme Unsinn — hingegangen wäre es trotzdem. */
  if (vertraulich.istVertraulich(channelId)) return;
  const sprache = store.getSelf(userId)?.language;
  if (!sprache) return;
  try {
    const sicht = await translatePoll(pollId, sprache);
    const poll = polls.getPoll(pollId, userId);
    if (!poll) return;
    // Auch ohne Übersetzung senden: wer zurück in die Ausgangssprache wechselt,
    // säße sonst weiter vor der englischen Fassung.
    sendToUser(userId, { t: 'poll:updated', poll: { ...poll, translation: sicht }, channelId });
  } catch (err) {
    console.error('[umfrage]', (err as Error).message);
  }
}

/**
 * Link-Vorschauen nachreichen. Läuft bewusst nach der Zustellung —
 * eine langsame fremde Website darf den Chat nicht aufhalten.
 */
function enrichLinks(messageId: string, text: string, channelId: string): void {
  /* Aus einem Chiffrat holt extractUrls ohnehin nichts heraus. Die Prüfung
     steht hier ausdrücklich, damit niemand sie später wieder wegoptimiert:
     eine Vorschau bedeutet, dass der Server die Adresse abruft — und damit
     jemandem verrät, welche Seite in einem vertraulichen Gespräch verlinkt
     wurde. */
  if (istE2EChiffrat(text)) return;
  if (!extractUrls(text).length) return;
  void attachPreviews(messageId, text)
    .then((links) => {
      if (!links.length) return;
      broadcast({ t: 'links', messageId, links }, store.memberIds(channelId));
    })
    .catch((err) => console.warn('[links]', (err as Error).message));
}

/**
 * Aufnahme transkribieren und das Ergebnis zum Nachrichtentext machen.
 * Damit greifen Suche und Übersetzung genauso wie bei getippten Nachrichten:
 * eine japanische Sprachnachricht landet auf Deutsch im Fenster.
 */
async function runTranscription(messageId: string, attachmentId: string): Promise<void> {
  const msg = store.getMessage(messageId);
  if (!msg) return;
  /* In einem vertraulichen Kanal wird nicht transkribiert. Das Transkript
     würde zum Nachrichtentext — im Klartext, auf dem Server, für ein Gespräch,
     das ausdrücklich niemand außer den Beteiligten lesen soll. Die Aufnahme
     bleibt hörbar, sie bekommt nur keine Abschrift. */
  if (vertraulich.istVertraulich(msg.channelId)) return;
  const audience = store.memberIds(msg.channelId);

  try {
    const result = await transcribe(attachmentId);
    saveTranscript(attachmentId, result);

    // Das Transkript ist ab jetzt der Text der Nachricht.
    database.run(
      'UPDATE messages SET text = ?, source_lang = ? WHERE id = ?',
      verschluesseln(result.text), result.lang, messageId,
    );
    reindexMessage(messageId);

    const updated = store.getMessage(messageId)!;
    for (const uid of audience) {
      sendToUser(uid, { t: 'message:updated', message: store.getMessage(messageId, uid)! });
      sendToUser(uid, { t: 'voice:transcript', messageId, voice: voiceNoteFor(messageId)! });
    }

    // Und jetzt wie jede andere Nachricht in die Sprachen der Empfänger bringen.
    const context = channelContext(updated.channelId);
    const langs = new Map<string, string[]>();
    for (const uid of audience) {
      if (uid === updated.userId) continue;
      const u = store.getUser(uid);
      if (!u?.autoTranslate) continue;
      const target = normalizeLang(u.language);
      if (target === (result.lang ?? 'unknown')) continue;
      langs.set(target, [...(langs.get(target) ?? []), uid]);
    }
    for (const [target, users] of langs) {
      void translateMessage(messageId, target, { force: true, context })
        .then((view) => {
          if (!view) return;
          for (const uid of users) sendToUser(uid, { t: 'translation', messageId, translation: view });
        })
        .catch(() => { /* Original bleibt sichtbar */ });
    }
  } catch (err) {
    console.warn('[voice]', (err as Error).message);
    for (const uid of audience) {
      sendToUser(uid, { t: 'voice:transcript', messageId, voice: voiceNoteFor(messageId)! });
    }
  }
}

/**
 * Antwortet der Assistent auf diese Nachricht? Läuft nach der Zustellung,
 * damit die Nachricht der Person sofort im Kanal steht und nicht auf das
 * Modell wartet.
 */
function vielleichtAntworten(channelId: string, text: string, authorId: string): void {
  /* In vertraulichen Kanälen schweigt der Assistent. Er könnte gar nicht
     antworten — er läse Base64 — aber die Prüfung steht trotzdem hier und
     nicht erst im Modell: der Verlauf ginge sonst als Anfrage an einen fremden
     Dienst, bevor irgendwer merkt, dass nichts dabei herauskommt. */
  if (vertraulich.istVertraulich(channelId)) return;
  if (!ki.shouldAnswer(channelId, text, authorId)) return;

  const botId = ki.assistantUserId();
  if (!botId) return;
  const empfaenger = store.memberIds(channelId);
  const istDm = store.getChannel(channelId)?.kind === 'dm';

  // "Denkt nach"-Anzeige, damit niemand ins Leere schaut.
  broadcast({ t: 'ai:thinking', channelId, active: true }, empfaenger);

  void ki.generateReply(channelId, istDm ? 'privat' : 'team')
    .then((antwort) => {
      const msg = messages.createMessage({
        channelId, userId: botId, text: antwort,
        mayMention: false, mayMentionEveryone: false,
      });
      deliverMessage(msg);
    })
    .catch((err) => {
      console.warn('[ki]', (err as Error).message);
      // Fehler gehören in den Chat, nicht nur ins Log — sonst wartet man endlos.
      const msg = messages.createMessage({
        channelId, userId: botId,
        text: `Ich konnte gerade nicht antworten: ${(err as Error).message}`,
        mayMention: false, mayMentionEveryone: false,
      });
      deliverMessage(msg);
    })
    .finally(() => {
      broadcast({ t: 'ai:thinking', channelId, active: false }, empfaenger);
    });
}

/**
 * Eine geänderte Idee geht an alle — mit der jeweils eigenen Stimme, denn
 * "myVote" unterscheidet sich je Person.
 */
/** Ein Termin geht an den Kreis seines Kanals — oder an alle, wenn er keinen hat. */
function broadcastTermin(termin: ReturnType<typeof events.getEvent>): void {
  if (!termin) return;
  broadcast({ t: 'event:upsert', event: termin }, empfaengerFuer(termin.channelId));
}

/** Abweisen, wenn der Termin an einem Kanal hängt, den man nicht sieht. */
function terminSichtbar(session: Session, termin: { channelId: string | null }): boolean {
  if (darfElementSehen(session.userId!, termin.channelId)) return true;
  fail(session, 'fehler.terminNichtGefunden', 'Termin nicht gefunden.');
  return false;
}

/** Dasselbe für Ideen. */
function ideeSichtbar(session: Session, idee: { channelId: string | null }): boolean {
  if (darfElementSehen(session.userId!, idee.channelId)) return true;
  fail(session, 'fehler.ideeNichtGefunden', 'Idee nicht gefunden.');
  return false;
}

/**
 * Eine Idee nach einem Umzug verteilen und bei denen aufräumen, die sie
 * verloren haben — dieselbe Überlegung wie bei umzugMelden() für Aufgaben.
 */
function ideenUmzugMelden(vorherKanal: string | null, idee: ReturnType<typeof ideas.getIdea>): void {
  if (!idee) return;
  for (const uid of verlorenGegangen(empfaengerFuer(vorherKanal), empfaengerFuer(idee.channelId))) {
    sendToUser(uid, { t: 'idea:removed', ideaId: idee.id });
  }
  broadcastIdee(idee);
}

function broadcastIdee(idee: ReturnType<typeof ideas.getIdea>): void {
  if (!idee) return;
  // Wie bei den Aufgaben: hängt sie an einem Kanal, geht sie nur an dessen Kreis.
  const kreis = empfaengerFuer(idee.channelId);
  for (const s of sessions.values()) {
    if (!s.userId) continue;
    if (kreis && !kreis.includes(s.userId)) continue;
    const eigene = ideas.getIdea(idee.id, s.userId);
    if (eigene) send(s, { t: 'idea:upsert', idea: eigene });
  }
}

/**
 * Wer eine Aufgabe sehen darf, entscheidet sich über den Kanal.
 *
 * Genau das stand hier schon als Kommentar — der Rundruf ging trotzdem an
 * jede offene Verbindung. Belegt: ein Nichtmitglied bekam „Kündigung …
 * vorbereiten" aus einem privaten Kanal zugestellt, und `task:list` gab sie
 * ihm ein zweites Mal. Seit die Aufgabenerkennung aus Nachrichten Titel
 * macht, ist das kein Schönheitsfehler mehr: der Kanal war vertraulich
 * gedacht, der Titel daraus lag im ganzen Haus.
 *
 * Ohne Kanal bleibt es wie bisher: eine Aufgabe, die niemandem gehört,
 * gehört allen.
 */
/** Abweisen, wenn die Aufgabe an einem Kanal hängt, den man nicht sieht. */
function aufgabeSichtbar(session: Session, task: Task): boolean {
  if (darfElementSehen(session.userId!, task.channelId)) return true;
  fail(session, 'fehler.aufgabeNichtGefunden', 'Aufgabe nicht gefunden.');
  return false;
}

/**
 * Der Vorschlag, den diese Person entscheiden darf — oder nichts.
 *
 * Zwei Fragen, die man nicht verwechseln darf. `nurEigener()` im Dienst prüft,
 * ob der Vorschlag ihr gehört; hier wird geprüft, ob sie den Kanal überhaupt
 * noch sehen darf. Adressat zu sein heißt nicht, dabei zu sein: wer aus einem
 * privaten Kanal entfernt wird, steht weiter unter `fuer_user_id`. Ohne diese
 * Prüfung könnte er den Vorschlag noch annehmen — und dessen Titel stammt aus
 * einer Nachricht, die er nicht mehr lesen darf.
 *
 * Dieselbe Regel wie bei Aufgaben, Terminen und Ideen, aus derselben
 * Funktion abgeleitet. Ein zweiter Empfängerkreis für Vorschläge wäre die
 * zweite Regel für dieselbe Frage.
 */
/**
 * Ein Fehler aus dem Vorschlagsdienst wird zur Kennung an die Oberfläche.
 *
 * `requestId` reist mit, damit der wartende Knopf die Absage zuordnen kann.
 * Ohne sie bliebe er drehen, bis die Frist zuschlägt — Antwort da, Kreisel an.
 */
function vorschlagFehler(session: Session, e: unknown, requestId?: string): void {
  if (e instanceof vorschlaege.VorschlagFehler) {
    fail(session, e.kennung, e.message, requestId);
    return;
  }
  throw e;
}

function vorschlagSichtbar(session: Session, vorschlagId: string, requestId?: string): Vorschlag | null {
  const v = vorschlaege.getVorschlag(vorschlagId);
  if (!v || !darfElementSehen(session.userId!, v.channelId)) {
    fail(session, 'fehler.vorschlagWeg', 'Diesen Vorschlag gibt es nicht mehr.', requestId);
    return null;
  }
  return v;
}

/**
 * Eine Aufgabe nach einer Änderung verteilen — und aufräumen, wenn sie den
 * Kanal gewechselt hat.
 *
 * Wer sie eben noch sah und jetzt nicht mehr, bekommt ein `task:removed`.
 * Ohne das bliebe sie auf seinem Brett stehen, bis er die Liste neu lädt —
 * also womöglich den ganzen Tag.
 */
function umzugMelden(vorher: Task, nachher: Task): void {
  const alterKreis = empfaengerFuer(vorher.channelId);
  const neuerKreis = empfaengerFuer(nachher.channelId);
  for (const uid of verlorenGegangen(alterKreis, neuerKreis)) {
    sendToUser(uid, { t: 'task:removed', taskId: nachher.id });
  }
  broadcast({ t: 'task:upsert', task: nachher }, neuerKreis);
}

function broadcastTask(task: Awaited<ReturnType<typeof tasks.getTask>>): void {
  if (!task) return;
  broadcast({ t: 'task:upsert', task }, empfaengerFuer(task.channelId));
}

/* ── Hintergrundaufgaben ──────────────────────────────────────── */

export function startBackgroundJobs(): () => void {
  // Geplante Nachrichten ausliefern
  const scheduler = setInterval(() => {
    try {
      for (const row of messages.dueScheduled(Date.now())) {
        try {
          /* Beim Planen wurde geprüft — aber zwischen Planen und Absenden kann
             der Kanal vertraulich geworden sein. Dann läge hier ein offener
             Text bereit, der gleich in einen Kanal ginge, in dem nur Chiffrat
             stehen darf. Verschlüsseln kann der Server ihn nicht, also geht er
             gar nicht erst hinaus; die geplante Nachricht verfällt, und wer sie
             geplant hat, erfährt warum. */
          if (vertraulich.istVertraulich(row.channel_id) && !istE2EChiffrat(row.text)) {
            messages.removeScheduled(row.id);
            sendToUser(row.user_id, { t: 'scheduled:removed', scheduledId: row.id });
            sendToUser(row.user_id, {
              t: 'error', code: 'fehler.vertraulichGeplant',
              message: 'Der Kanal ist inzwischen vertraulich — deine geplante Nachricht wurde nicht '
                + 'gesendet, weil sie noch unverschlüsselt war. Bitte schreibe sie neu.',
            });
            continue;
          }
          const msg = messages.createMessage({
            channelId: row.channel_id, userId: row.user_id, text: row.text, parentId: row.parent_id,
          });
          messages.removeScheduled(row.id);
          sendToUser(row.user_id, { t: 'scheduled:removed', scheduledId: row.id });
          deliverMessage(msg);
        } catch (err) {
          console.error('[scheduler]', (err as Error).message);
          messages.removeScheduled(row.id);
        }
      }
    } catch (err) {
      console.error('[scheduler]', (err as Error).message);
    }
  }, 5_000);

  // Fällige Erinnerungen zustellen
  const reminderTimer = setInterval(() => {
    try {
      /* Nur für Leute holen, die gerade verbunden sind — und erst abhaken,
         wenn sie wirklich draußen ist. Vorher wurde jede fällige Erinnerung
         abgehakt und dann losgeschickt; war niemand da, war sie weg. Wer
         abends „morgen um neun" setzt und um neun den Rechner noch zu hat,
         bekam sie nie und fand sie auch nicht mehr in seiner Liste. */
      for (const reminder of reminders.due(Date.now(), onlineUserIds())) {
        try {
          const owner = ownerOfReminder(reminder.id);
          if (!owner || !isOnline(owner)) continue;   // wartet auf die Rückkehr
          const message = reminder.messageId ? store.getMessage(reminder.messageId, owner) : null;
          sendToUser(owner, { t: 'reminder:fire', reminder, message });
          database.run('UPDATE reminders SET done = 1 WHERE id = ?', reminder.id);
        } catch (err) {
          // Eine kaputte Erinnerung darf die anderen dieses Durchgangs nicht
          // mitnehmen — vorher brach die Schleife beim ersten Wurf ab.
          console.error('[reminders]', reminder.id, (err as Error).message);
        }
      }
    } catch (err) {
      console.error('[reminders]', (err as Error).message);
    }
  }, 15_000);

  // Abgelaufene Status zurücksetzen ("bin gleich zurück" soll nicht ewig stehen)
  const statusTimer = setInterval(() => {
    try {
      const jetzt = Date.now();
      const expired = database.all<{ id: string }>(
        'SELECT id FROM users WHERE status_expires_at IS NOT NULL AND status_expires_at <= ?', jetzt,
      );
      for (const row of expired) {
        /*
         * Mit der Frist endet der Status selbst, nicht nur Zeichen und Text.
         * Vorher verschwand allein das Emoji, und „bitte nicht stören" stand
         * hinterher für immer da — rot, ohne Erklärung daneben. Was danach
         * gilt, entscheidet die Verbindung: wer noch dranhängt, ist online.
         */
        const zurueck: UserStatus = isOnline(row.id) ? 'online' : 'offline';
        database.run(
          "UPDATE users SET status = ?, status_emoji = NULL, status_text = NULL, status_expires_at = NULL WHERE id = ?",
          zurueck, row.id,
        );
        const u = store.getUser(row.id);
        if (u) {
          broadcast({
            t: 'presence', userId: row.id, status: u.status,
            statusEmoji: null, statusText: null, statusExpiresAt: null, lastSeenAt: u.lastSeenAt,
          });
        }
      }

      /*
       * Wer verbunden ist, aber lange nichts getan hat, wandert auf abwesend.
       * Ohne das bleibt ein offener, vergessener Rechner für alle anderen
       * grün — die Verbindung steht ja, nur der Mensch davor nicht mehr.
       */
      const grenze = jetzt - LEERLAUF_MS;
      for (const uid of byUser.keys()) {
        if ((letzteAktion.get(uid) ?? jetzt) > grenze) continue;
        if (statusHaelt(uid)) continue;
        if (store.getUser(uid)?.status !== 'online') continue;
        setStatus(uid, 'away');
      }
    } catch (err) {
      console.error('[status]', (err as Error).message);
    }
  }, 30_000);

  // Hat das Aktualisierungsskript eine Auszeit hinterlegt? Dann einmal
  // ansagen — und einmal, wenn sie wieder verschwindet.
  let angesagt: string | null = null;
  const wartungsTimer = setInterval(() => {
    try {
      const w = wartung.anstehend();
      if (w && w.version !== angesagt) {
        angesagt = w.version;
        broadcast({ t: 'server:update', ...w, serverZeit: Date.now() });
      } else if (!w && angesagt) {
        angesagt = null;
        broadcast({ t: 'server:update-abgesagt' });
      }
    } catch (err) {
      console.error('[wartung]', (err as Error).message);
    }
  }, 5_000);

  // Termine, die in 15 Minuten beginnen, einmal ankündigen
  const gemeldet = new Set<string>();
  const terminTimer = setInterval(() => {
    try {
      for (const termin of events.startingSoon(15 * 60_000)) {
        if (gemeldet.has(termin.id)) continue;
        gemeldet.add(termin.id);
        for (const teil of termin.attendees) {
          if (teil.response === 'no') continue;
          sendToUser(teil.userId, {
            t: 'reminder:fire',
            reminder: {
              id: `ev_${termin.id}`, messageId: null, channelId: termin.channelId ?? '',
              note: termin.title, remindAt: termin.startsAt, done: false, createdAt: Date.now(),
            },
            message: null,
          });
        }
      }
      // Der Merker darf nicht unbegrenzt wachsen.
      if (gemeldet.size > 500) gemeldet.clear();
    } catch (err) {
      console.error('[termine]', (err as Error).message);
    }
  }, 60_000);

  /* Abgelaufene Freigaben entschärfen.
     Der Ablauf wird bei jedem Öffnen geprüft — aber solange die Pakete
     daliegen, hängt alles an dieser einen Prüfung. Ein Fehler dort, und eine
     Freigabe von vor zwei Jahren stünde wieder offen. Werden die Pakete
     gelöscht, ist der Ablauf keine Regel mehr, sondern ein Zustand. */
  const freigabenTimer = setInterval(() => {
    try {
      const weg = vertraulich.abgelaufeneAufraeumen();
      if (weg) console.log(`[vertraulich] ${weg} abgelaufene Freigaben entschärft.`);
    } catch (err) {
      console.error('[vertraulich]', (err as Error).message);
    }
  }, 10 * 60_000);

  // Tote Sockets aussortieren
  const heartbeat = setInterval(() => {
    for (const s of sessions.values()) {
      /* Auch terminate() gehört in den Schutz. Wirft es — und bei einem
         Socket, den das Betriebssystem schon weggeräumt hat, kann es das —,
         blieb der Rest dieses Durchgangs ungeprüft: die toten Verbindungen
         dahinter überlebten bis zum nächsten Wurf an derselben Stelle. */
      try {
        if (!s.alive) { s.socket.terminate(); continue; }
        s.alive = false;
        s.socket.ping();
      } catch { /* dann eben beim nächsten Mal */ }
    }
  }, 30_000);

  /* Neue Vorschläge gehen ungefragt an genau eine Person — den Adressaten.
     Der Dienst kennt das Gateway nicht; die Zustellung wird eingehängt,
     damit er ohne WebSocket prüfbar bleibt. Auch hier gilt der Kanalkreis:
     wer den Kanal nicht mehr sieht, bekommt nichts daraus. */
  vorschlaege.zustellerSetzen((userId, neue) => {
    for (const v of neue) {
      if (!darfElementSehen(userId, v.channelId)) continue;
      sendToUser(userId, { t: 'vorschlag:neu', vorschlag: v });
    }
  });
  const stopVorschlaege = vorschlaege.startVorschlagJob();

  return () => {
    vorschlaege.zustellerSetzen(null);
    stopVorschlaege();
    clearInterval(scheduler);
    clearInterval(reminderTimer);
    clearInterval(statusTimer);
    clearInterval(terminTimer);
    clearInterval(wartungsTimer);
    clearInterval(freigabenTimer);
    clearInterval(heartbeat);
  };
}

/** Zu wem gehört die Erinnerung? Die Liste liefert sie ohne Besitzer mit. */
function ownerOfReminder(reminderId: string): string {
  return database.get<{ user_id: string }>('SELECT user_id FROM reminders WHERE id = ?', reminderId)?.user_id ?? '';
}

/**
 * Beendet alle offenen Verbindungen eines Kontos.
 *
 * Wird ein Konto gelöscht oder gesperrt, hilft die Prüfung beim Anmelden
 * allein nicht: wer gerade verbunden ist, bleibt es — im schlimmsten Fall
 * einen Monat lang, bis das Token abläuft. Also aktiv hinauswerfen.
 */
export function sitzungenBeenden(userId: string, grund = 'Dieses Konto ist nicht mehr aktiv.'): void {
  for (const s of byUser.get(userId) ?? new Set<Session>()) {
    try {
      fail(s, 'fehler.kontoInaktiv', grund);
      s.socket.close();
    } catch { /* schon zu — dann ist nichts zu tun */ }
  }
}

export function onlineUserIds(): string[] {
  return [...byUser.keys()];
}

/** Wie viele Verbindungen gerade offen sind — und wie viele Menschen dahinter. */
export function verbindungen(): { clients: number; benutzer: number } {
  return { clients: sessions.size, benutzer: byUser.size };
}

/**
 * Beim Start aufräumen: niemand kann verbunden sein, bevor es einen Server gibt.
 *
 * Ohne das bleibt der Stand vom letzten Mal stehen — nach einem Absturz oder
 * einem Update stünden Leute tagelang als "online" da, die längst weg sind.
 */
export function anwesenheitZuruecksetzen(): void {
  const betroffen = database.run(
    "UPDATE users SET status = 'offline' WHERE status <> 'offline'",
  );
  void betroffen;
}
