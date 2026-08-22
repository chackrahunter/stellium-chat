/**
 * Gmail über die HTTP-Schnittstelle — ohne ein einziges fremdes Paket.
 *
 * Der naheliegende Weg wäre IMAP gewesen. Dagegen sprach nicht der Aufwand
 * für das Protokoll selbst (das ist Text und überschaubar), sondern das, was
 * danach kommt: echte Post ist mehrteilig, base64- oder
 * quoted-printable-kodiert, in wechselnden Zeichensätzen, mit Anhängen. Einen
 * MIME-Zerleger von Hand zu schreiben heißt, jahrelang Sonderfälle
 * nachzureichen — und bis dahin zeigt die Anzeige gelegentlich Zeichensalat.
 *
 * Gmail liefert dieselbe Post bereits zerlegt: `payload` mit `parts`, jeder
 * Teil mit seinem Typ und seinem Inhalt in base64url. Damit bleibt hier nur
 * Baumlaufen und Dekodieren. Der Server hat dafür alles an Bord.
 *
 * Was NICHT hier steht: die Zugangsdaten. Die liegen verschlüsselt in
 * `mailzugang.ts` und werden nur zum Holen eines kurzlebigen Zugangs-Tokens
 * benutzt. Das Aktualisierungs-Token verlässt den Server nie, und in kein
 * Protokoll dieser Datei gerät je ein Geheimnis — auch nicht in eine
 * Fehlermeldung.
 */
import { zugangLesen } from './mailzugang.js';

const TOKEN_ENDE = 'https://oauth2.googleapis.com/token';
const API = 'https://gmail.googleapis.com/gmail/v1/users/me';

export class MailFehler extends Error {
  constructor(public code: string, nachricht: string, public status = 502) {
    super(nachricht);
  }
}

/* ── Zugangs-Token ─────────────────────────────────────────────
   Es gilt eine knappe Stunde. Für jede Anfrage ein neues zu holen wäre eine
   zusätzliche Fahrt nach Google je Mausklick; deshalb wird es behalten und
   eine Minute vor Ablauf erneuert. Die Minute Abstand ist Absicht: sonst
   scheitert genau die Anfrage, die auf die Sekunde in den Ablauf läuft. */
let token: { wert: string; bis: number } | null = null;

async function zugangsToken(): Promise<string> {
  const jetzt = Date.now();
  if (token && jetzt < token.bis) return token.wert;

  const z = zugangLesen();
  if (!z) throw new MailFehler('mail.nichtEingerichtet', 'Kein Postfach hinterlegt.', 400);

  const antwort = await fetch(TOKEN_ENDE, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: z.kennung,
      client_secret: z.geheimnis,
      refresh_token: z.token,
      grant_type: 'refresh_token',
    }),
    signal: AbortSignal.timeout(15_000),
  }).catch((f) => {
    throw new MailFehler('mail.keineVerbindung', `Google nicht erreichbar: ${(f as Error).message}`, 503);
  });

  if (!antwort.ok) {
    /* Der Text von Google enthält kein Geheimnis (er nennt nur den Fehlergrund),
       wird aber trotzdem gekürzt: eine Fehlermeldung ist keine Protokolldatei. */
    const grund = (await antwort.text().catch(() => '')).slice(0, 200);
    /* 400 mit `invalid_grant` heißt fast immer: die Zustimmung wurde
       zurückgezogen oder das Token ist abgelaufen. Das ist kein Ausfall,
       sondern eine Aufgabe für einen Menschen — und die Meldung soll das
       sagen, statt „502" zu behaupten. */
    if (antwort.status === 400 && grund.includes('invalid_grant')) {
      throw new MailFehler('mail.zugangAbgelaufen',
        'Der Zugang zum Postfach gilt nicht mehr. Er muss neu erteilt werden.', 400);
    }
    throw new MailFehler('mail.tokenFehler', `Google lehnt den Zugang ab (${antwort.status}). ${grund}`, 502);
  }

  const d = await antwort.json() as { access_token?: string; expires_in?: number };
  if (!d.access_token) throw new MailFehler('mail.tokenFehler', 'Google antwortet ohne Token.', 502);
  token = { wert: d.access_token, bis: jetzt + ((d.expires_in ?? 3600) - 60) * 1000 };
  return token.wert;
}

/** Das behaltene Token wegwerfen — nach einem Wechsel der Zugangsdaten. */
export function tokenVergessen(): void { token = null; }

/* ── Eine Anfrage an Gmail ───────────────────────────────────── */

async function ruf<T>(pfad: string, aufbau?: RequestInit, zweiterVersuch = false): Promise<T> {
  const t = await zugangsToken();
  const antwort = await fetch(`${API}${pfad}`, {
    ...aufbau,
    headers: {
      authorization: `Bearer ${t}`,
      ...(aufbau?.body ? { 'content-type': 'application/json' } : {}),
      ...aufbau?.headers,
    },
    signal: AbortSignal.timeout(30_000),
  }).catch((f) => {
    throw new MailFehler('mail.keineVerbindung', `Gmail nicht erreichbar: ${(f as Error).message}`, 503);
  });

  /* Ein einziger zweiter Versuch: das Token kann auf dem Weg abgelaufen sein
     (Uhren gehen auseinander). Beim zweiten 401 liegt es nicht mehr daran,
     und weiterzuprobieren hieße nur, den Fehler zu verschleppen. */
  if (antwort.status === 401 && !zweiterVersuch) {
    token = null;
    return ruf<T>(pfad, aufbau, true);
  }
  if (!antwort.ok) {
    const grund = (await antwort.text().catch(() => '')).slice(0, 200);
    throw new MailFehler('mail.abgelehnt', `Gmail antwortet mit ${antwort.status}. ${grund}`, 502);
  }
  return await antwort.json() as T;
}

/* ── Ordner ────────────────────────────────────────────────────
   Gmail kennt keine Ordner, sondern Etiketten — eine Nachricht kann mehrere
   tragen. Für die Anzeige ist das aber genau dasselbe: „Posteingang",
   „Gesendet", „Spam" sind Etiketten, die Google selbst vergibt (`type: system`),
   daneben stehen die selbst angelegten. */

export interface Ordner {
  id: string;
  name: string;
  /** `system` sind Gmails eigene, `user` die selbst angelegten. */
  art: 'system' | 'user';
  ungelesen: number;
  gesamt: number;
}

export async function ordner(): Promise<Ordner[]> {
  const d = await ruf<{ labels?: Array<{ id: string; name: string; type?: string }> }>('/labels');
  const roh = d.labels ?? [];
  /* Die Zählstände stehen NICHT in der Liste — dafür braucht jedes Etikett
     eine eigene Abfrage. Vier Dutzend Fahrten für eine Seitenleiste wären zu
     viel; geholt werden sie deshalb nur für die, die man wirklich sieht. */
  return roh.map((l) => ({
    id: l.id,
    name: l.name,
    art: l.type === 'system' ? 'system' as const : 'user' as const,
    ungelesen: 0,
    gesamt: 0,
  }));
}

/** Zählstand eines einzelnen Etiketts — eine Fahrt je Etikett. */
export async function ordnerStand(id: string): Promise<{ ungelesen: number; gesamt: number }> {
  const d = await ruf<{ messagesTotal?: number; messagesUnread?: number }>(
    `/labels/${encodeURIComponent(id)}`);
  return { ungelesen: d.messagesUnread ?? 0, gesamt: d.messagesTotal ?? 0 };
}

/* ── Nachrichten ─────────────────────────────────────────────── */

export interface Kopf {
  id: string;
  threadId: string;
  von: string;
  an: string;
  betreff: string;
  /** Millisekunden seit 1970 — wie überall sonst in Stellium. */
  am: number;
  auszug: string;
  gelesen: boolean;
  etiketten: string[];
}

export interface Nachricht extends Kopf {
  text: string;
  html: string | null;
  anhaenge: Array<{ id: string; name: string; typ: string; groesse: number }>;
}

type GPart = {
  mimeType?: string;
  filename?: string;
  body?: { data?: string; size?: number; attachmentId?: string };
  parts?: GPart[];
  headers?: Array<{ name: string; value: string }>;
};
type GMessage = {
  id: string; threadId: string; snippet?: string; internalDate?: string;
  labelIds?: string[]; payload?: GPart;
};

/** base64url, wie Google es liefert. */
function ausB64(d: string | undefined): Buffer {
  if (!d) return Buffer.alloc(0);
  return Buffer.from(d.replace(/-/g, '+').replace(/_/g, '/'), 'base64');
}

/* Node kennt nur eine Handvoll Zeichensätze. Die drei, die in Post wirklich
   vorkommen, decken praktisch alles ab; alles Übrige wird als UTF-8 gelesen.
   Das ist besser als zu raten: falsch dekodiert sieht man sofort, still
   verworfen nicht. */
function alsText(roh: Buffer, zeichensatz?: string): string {
  const z = (zeichensatz ?? '').toLowerCase();
  if (z.includes('iso-8859') || z.includes('latin') || z.includes('windows-12')) {
    return roh.toString('latin1');
  }
  return roh.toString('utf8');
}

function kopfzeile(p: GPart | undefined, name: string): string {
  const n = name.toLowerCase();
  return p?.headers?.find((h) => h.name.toLowerCase() === n)?.value ?? '';
}

/** Den ersten Teil eines Typs im Baum finden. */
function teilSuchen(p: GPart | undefined, typ: string): GPart | null {
  if (!p) return null;
  if ((p.mimeType ?? '').toLowerCase() === typ && p.body?.data) return p;
  for (const k of p.parts ?? []) {
    const t = teilSuchen(k, typ);
    if (t) return t;
  }
  return null;
}

function anhaengeSammeln(p: GPart | undefined, heraus: Nachricht['anhaenge'] = []): Nachricht['anhaenge'] {
  if (!p) return heraus;
  if (p.filename && p.body?.attachmentId) {
    heraus.push({
      id: p.body.attachmentId,
      name: p.filename,
      typ: p.mimeType ?? 'application/octet-stream',
      groesse: p.body.size ?? 0,
    });
  }
  for (const k of p.parts ?? []) anhaengeSammeln(k, heraus);
  return heraus;
}

function kopfBauen(m: GMessage): Kopf {
  const p = m.payload;
  return {
    id: m.id,
    threadId: m.threadId,
    von: kopfzeile(p, 'from'),
    an: kopfzeile(p, 'to'),
    betreff: kopfzeile(p, 'subject'),
    /* `internalDate` ist Gmails eigene Zeit in Millisekunden. Die Kopfzeile
       `Date` stammt vom Absender und ist gelegentlich falsch gestellt —
       Post aus der Zukunft stünde dann für immer oben. */
    am: Number(m.internalDate ?? 0) || 0,
    auszug: m.snippet ?? '',
    gelesen: !(m.labelIds ?? []).includes('UNREAD'),
    etiketten: m.labelIds ?? [],
  };
}

/**
 * Eine Seite eines Ordners.
 *
 * Gmail gibt auf die Listenabfrage nur Kennungen zurück — für Absender und
 * Betreff braucht jede Nachricht eine eigene Fahrt. Für fünfundzwanzig
 * nacheinander wären das bei 40 ms Laufzeit eine Sekunde Wartezeit; deshalb
 * laufen sie nebeneinander. Mehr als zehn gleichzeitig bringt nichts und
 * riskiert nur Gmails Drosselung.
 */
export async function liste(
  ordnerId: string, weiterAb?: string, suche?: string, anzahl = 25,
): Promise<{ nachrichten: Kopf[]; weiter: string | null }> {
  const p = new URLSearchParams({ maxResults: String(anzahl) });
  if (ordnerId) p.set('labelIds', ordnerId);
  if (weiterAb) p.set('pageToken', weiterAb);
  if (suche) p.set('q', suche);

  const d = await ruf<{ messages?: Array<{ id: string }>; nextPageToken?: string }>(
    `/messages?${p.toString()}`);
  const ids = (d.messages ?? []).map((m) => m.id);
  const heraus: Kopf[] = [];

  for (let i = 0; i < ids.length; i += 10) {
    const teil = await Promise.all(ids.slice(i, i + 10).map((id) =>
      ruf<GMessage>(`/messages/${id}?format=metadata`
        + '&metadataHeaders=From&metadataHeaders=To&metadataHeaders=Subject')
        .then(kopfBauen)
        /* Eine einzelne Nachricht, die gerade gelöscht wurde, darf nicht die
           ganze Seite kippen. */
        .catch(() => null)));
    for (const k of teil) if (k) heraus.push(k);
  }

  return { nachrichten: heraus, weiter: d.nextPageToken ?? null };
}

/** Eine Nachricht mit Inhalt. */
export async function nachricht(id: string): Promise<Nachricht> {
  const m = await ruf<GMessage>(`/messages/${encodeURIComponent(id)}?format=full`);
  const kopf = kopfBauen(m);

  const nur = teilSuchen(m.payload, 'text/plain');
  const web = teilSuchen(m.payload, 'text/html');
  /* Ist die Nachricht einteilig, steht der Text direkt am Rumpf und nicht in
     einem Teil — dann greift `teilSuchen` nicht. */
  const einfach = !nur && !web && m.payload?.body?.data ? m.payload : null;

  const zeichensatz = (t: GPart | null) =>
    /charset="?([\w-]+)"?/i.exec(kopfzeile(t ?? undefined, 'content-type'))?.[1];

  return {
    ...kopf,
    text: nur ? alsText(ausB64(nur.body?.data), zeichensatz(nur))
      : einfach ? alsText(ausB64(einfach.body?.data), zeichensatz(einfach))
        : '',
    html: web ? alsText(ausB64(web.body?.data), zeichensatz(web)) : null,
    anhaenge: anhaengeSammeln(m.payload),
  };
}

/** Gelesen-Zustand setzen. */
export async function gelesenSetzen(id: string, gelesen: boolean): Promise<void> {
  await ruf(`/messages/${encodeURIComponent(id)}/modify`, {
    method: 'POST',
    body: JSON.stringify(gelesen ? { removeLabelIds: ['UNREAD'] } : { addLabelIds: ['UNREAD'] }),
  });
}

/** In einen anderen Ordner legen — bei Gmail: Etiketten tauschen. */
export async function verschieben(id: string, hinzu: string[], weg: string[]): Promise<void> {
  await ruf(`/messages/${encodeURIComponent(id)}/modify`, {
    method: 'POST',
    body: JSON.stringify({ addLabelIds: hinzu, removeLabelIds: weg }),
  });
}

/* ── Senden ────────────────────────────────────────────────────
 *
 * Gmail nimmt eine fertige Nachricht nach RFC 5322 entgegen, base64url
 * verpackt. Zusammengesetzt wird sie hier, und das ist bewusst wenig Code:
 * wir schreiben nur Post, die wir selbst verfasst haben — kein Anhang, keine
 * fremden Kopfzeilen, keine Altlasten. Lesen ist das Schwere, Schreiben nicht.
 */

/* Nicht-ASCII in einer Kopfzeile muss kodiert werden, sonst kommt beim
   Empfänger Zeichensalat an — und deutsche Betreffzeilen haben nun einmal
   Umlaute. RFC 2047, base64-Form. */
function kopfKodieren(wert: string): string {
  // eslint-disable-next-line no-control-regex
  if (/^[\x00-\x7F]*$/.test(wert)) return wert;
  return `=?UTF-8?B?${Buffer.from(wert, 'utf8').toString('base64')}?=`;
}

/* Base64 im Rumpf wird auf 76 Zeichen umbrochen. Ohne das entsteht eine
   einzige sehr lange Zeile, und manche Zustellwege kürzen die. */
function umbrechen(s: string): string {
  return (s.match(/.{1,76}/g) ?? []).join('\r\n');
}

export interface Ausgang {
  an: string;
  betreff: string;
  text: string;
  /** Der Name, unter dem geschrieben wird — etwa „Stellium". */
  absenderName?: string;
  /** Für eine Antwort: Kennung und Verlauf der Ursprungsnachricht. */
  antwortAuf?: { messageId: string; threadId: string; referenzen?: string };
}

export async function senden(m: Ausgang): Promise<{ id: string; threadId: string }> {
  const z = zugangLesen();
  if (!z) throw new MailFehler('mail.nichtEingerichtet', 'Kein Postfach hinterlegt.', 400);

  const von = m.absenderName
    ? `${kopfKodieren(m.absenderName)} <${z.adresse}>`
    : z.adresse;

  const zeilen = [
    `From: ${von}`,
    `To: ${m.an}`,
    `Subject: ${kopfKodieren(m.betreff)}`,
    `Date: ${new Date().toUTCString()}`,
    'MIME-Version: 1.0',
    'Content-Type: text/plain; charset="UTF-8"',
    'Content-Transfer-Encoding: base64',
  ];

  /* Ohne diese beiden Zeilen ist eine Antwort keine Antwort, sondern eine
     neue Nachricht mit „Re:" davor: Mailprogramme hängen den Verlauf an
     `In-Reply-To` und `References` auf, nicht am Betreff. */
  if (m.antwortAuf?.messageId) {
    zeilen.push(`In-Reply-To: ${m.antwortAuf.messageId}`);
    zeilen.push(`References: ${m.antwortAuf.referenzen
      ? `${m.antwortAuf.referenzen} ${m.antwortAuf.messageId}` : m.antwortAuf.messageId}`);
  }

  const roh = `${zeilen.join('\r\n')}\r\n\r\n${umbrechen(Buffer.from(m.text, 'utf8').toString('base64'))}`;
  const verpackt = Buffer.from(roh, 'utf8').toString('base64')
    .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

  const d = await ruf<{ id: string; threadId: string }>('/messages/send', {
    method: 'POST',
    body: JSON.stringify({
      raw: verpackt,
      /* Im selben Verlauf antworten, damit es beim Empfänger unter der
         ursprünglichen Nachricht landet und nicht daneben. */
      ...(m.antwortAuf?.threadId ? { threadId: m.antwortAuf.threadId } : {}),
    }),
  });
  return d;
}

/** Die `Message-ID` einer Nachricht — für `In-Reply-To` beim Antworten. */
export async function messageId(id: string): Promise<{ messageId: string; referenzen: string }> {
  const m = await ruf<GMessage>(`/messages/${encodeURIComponent(id)}?format=metadata`
    + '&metadataHeaders=Message-ID&metadataHeaders=References');
  return {
    messageId: kopfzeile(m.payload, 'message-id'),
    referenzen: kopfzeile(m.payload, 'references'),
  };
}
