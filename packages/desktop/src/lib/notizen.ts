import {
  nutzlastLesen, nutzlastSchreiben,
  type ClientEvent, type Notiz, type SchluesselPaket, type ServerEvent,
} from '@stellium/shared';
import { socket } from '../net/socket.js';
import { useStore } from '../state/store.js';
import { spracheDesSystems, translate, type TranslationKey } from '../i18n/kern.js';
import {
  b64u, eigenerOeffentlicherSchluessel, fremderOeffentlicherSchluessel,
  habeSchluessel, paketAuspacken, paketPacken, schluesselAnfordern, unb64u,
} from './vertraulich.js';

/**
 * Notizen — dieselbe Schlüsselarbeit wie in lib/vertraulich.ts, nur für
 * Schriftstücke statt Kanäle. Absichtlich KEINE eigene Verschlüsselung:
 * gemeinsamerSchluessel(), paketPacken() und paketAuspacken() sind von dort
 * importiert, unverändert. Was hier eigen ist, ist ausschließlich die
 * Bauart des Inhalts (Titel + Text statt eines Nachrichtenstroms) und die
 * Fassungsverwaltung ohne Vergangenheit — siehe schema.sql und
 * services/notizen.ts für die ausführliche Begründung.
 *
 * Wie beim Vorbild: der private Schlüssel liegt nie auf dem Server, und der
 * Server bekommt vom Inhalt — auch vom Titel — nie mehr als Chiffrat zu
 * sehen.
 */

function txt(key: TranslationKey, werte?: Record<string, string | number>): string {
  return translate(useStore.getState().self?.uiLanguage || spracheDesSystems(), key, werte);
}

const enc = new TextEncoder();
const dec = new TextDecoder();

/** Kontext einer Notiz — eigenes Präfix, damit dieselbe ECDH-Rechnung nie mit
 *  einem Kanalpaket verwechselt werden kann (siehe paketKontext in
 *  lib/vertraulich.ts, derselbe Gedanke). */
function notizKontext(notizId: string, fassung: number, von: string, fuer: string): string {
  return `stellium/notiz/${notizId}/${fassung}/${von}>${fuer}`;
}

/** Eine neue, zufällige Notiz-Kennung — siehe Protokoll (notiz:anlegen) für
 *  die Begründung, warum sie hier und nicht auf dem Server entsteht. */
function neueNotizId(): string {
  return `nz_${crypto.randomUUID().replace(/-/g, '')}`;
}

function neueRequestId(): string {
  return Math.random().toString(36).slice(2, 11);
}

/** Entschlüsselte Notizschlüssel, nur im Speicher — wie kanalSchluessel in
 *  lib/vertraulich.ts: auf der Platte bleiben nur die Pakete, der Server
 *  liefert sie bei jedem Start neu. */
const notizSchluessel = new Map<string, { fassung: number; key: CryptoKey }>();

/* ── Inhalt ver- und entschlüsseln ────────────────────────────── */

interface NotizInhalt { titel: string; text: string }

/** Was state/store.ts unter notizenKlartext[id] hält — siehe decodiereUndSpeichere(). */
export interface NotizKlartext extends NotizInhalt { version: number }

async function inhaltVerschluesseln(fassung: number, key: CryptoKey, inhalt: NotizInhalt): Promise<string> {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const daten = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, enc.encode(JSON.stringify(inhalt)));
  return nutzlastSchreiben({ fassung, iv: b64u(iv), daten: b64u(daten) });
}

async function inhaltEntschluesseln(key: CryptoKey, roh: string): Promise<NotizInhalt | null> {
  const nutzlast = nutzlastLesen(roh);
  if (!nutzlast) return null;
  try {
    const klar = await crypto.subtle.decrypt(
      { name: 'AES-GCM', iv: unb64u(nutzlast.iv) }, key, unb64u(nutzlast.daten),
    );
    const geparst = JSON.parse(dec.decode(klar)) as Partial<NotizInhalt>;
    return { titel: geparst.titel ?? '', text: geparst.text ?? '' };
  } catch {
    return null;
  }
}

/**
 * Versucht, eine Notiz mit dem gerade vorhandenen Schlüssel zu lesen, und
 * schreibt das Ergebnis in den Zustand — `null`, solange der passende
 * Schlüssel (noch) fehlt, nie eine Fehlermeldung: das ist der Normalfall
 * kurz nach dem Öffnen der Tafel, bevor notiz:schluessel eingetroffen ist.
 *
 * Der Klartext trägt die `version`, zu der er gehört, mit sich. Grund: die
 * Metadaten in notizen[id] aktualisieren sich sofort (synchron, in
 * verarbeiten() unten), der Klartext erst nach dem asynchronen Entschlüsseln
 * hier — dazwischen liegt ein kurzer Augenblick, in dem `notizen[id].version`
 * schon die neue Zahl trägt, notizenKlartext[id] aber noch den alten Inhalt.
 * Wer daraus etwas errechnet, das den Server erreicht (siehe
 * notizMitgliedEntfernen), muss diesen Augenblick erkennen können, statt
 * versehentlich mit veraltetem Inhalt weiterzurechnen.
 */
async function decodiereUndSpeichere(notiz: Notiz): Promise<void> {
  const eintrag = notizSchluessel.get(notiz.id);
  if (!eintrag || eintrag.fassung !== notiz.schluesselFassung) {
    useStore.setState((s) => ({ notizenKlartext: { ...s.notizenKlartext, [notiz.id]: null } }));
    return;
  }
  const inhalt = await inhaltEntschluesseln(eintrag.key, notiz.chiffrat);
  useStore.setState((s) => ({
    notizenKlartext: {
      ...s.notizenKlartext,
      [notiz.id]: inhalt ? { ...inhalt, version: notiz.version } : null,
    },
  }));
}

/**
 * Auf den entschlüsselten Stand warten, der zu `version` gehört — siehe
 * decodiereUndSpeichere() für den Augenblick, den das überbrückt. Kurz und
 * mit Obergrenze: entweder ist der Entschlüsselungslauf, der gerade
 * unterwegs ist, in Millisekunden fertig, oder es fehlt tatsächlich der
 * Schlüssel, und dann soll ein Aufrufer das als Fehler sehen, nicht ewig
 * warten.
 */
async function klartextFuerVersionWarten(notizId: string, version: number): Promise<NotizKlartext | null> {
  for (let i = 0; i < 30; i++) {
    const stand = useStore.getState().notizenKlartext[notizId];
    if (stand && stand.version === version) return stand;
    const notiz = useStore.getState().notizen[notizId];
    if (!notiz || notiz.version !== version) return null; // schon wieder überholt
    await new Promise((r) => setTimeout(r, 50));
  }
  return null;
}

/* ── Anfrage/Antwort für die Aktionen, die eine Zusage brauchen ──
   socket.send() selbst kennt keine Antwort — dieselbe Lücke wie in
   state/store.ts (dort: awaitReply/frageHinaus), hier als eigene, kleine
   Fassung, weil das dortige Register modul-privat ist. */
const wartend = new Map<string, { aufloesen: (ev: ServerEvent) => void; ablehnen: (err: Error) => void }>();

function anfrageSenden(ev: ClientEvent & { requestId: string }): Promise<ServerEvent> {
  const requestId = ev.requestId;
  return new Promise((aufloesen, ablehnen) => {
    const frist = window.setTimeout(() => {
      wartend.delete(requestId);
      ablehnen(new Error(txt('fehler.keineAntwort')));
    }, 15_000);
    wartend.set(requestId, {
      aufloesen: (antwort) => { clearTimeout(frist); aufloesen(antwort); },
      ablehnen: (err) => { clearTimeout(frist); ablehnen(err); },
    });
    if (!socket.send(ev)) {
      wartend.delete(requestId);
      clearTimeout(frist);
      ablehnen(new Error(txt('fehler.keineVerbindung')));
    }
  });
}

/* ── Anfordern ─────────────────────────────────────────────────── */

/** Die eigenen Notizen laden — beim Öffnen der Tafel. */
export function notizenAnfordern(): void {
  socket.send({ t: 'notiz:list' });
}

/* ── Anlegen ───────────────────────────────────────────────────── */

export async function notizErstellen(titel: string, text: string): Promise<Notiz> {
  if (!habeSchluessel()) throw new Error(txt('fehler.keinSchluesselpaar'));
  const meinJwk = eigenerOeffentlicherSchluessel();
  if (!meinJwk) throw new Error(txt('fehler.keinSchluesselpaar'));

  const id = neueNotizId();
  const self = useStore.getState().self;
  if (!self) throw new Error(txt('fehler.keineVerbindung'));

  const key = await crypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, true, ['encrypt', 'decrypt']);
  const chiffrat = await inhaltVerschluesseln(1, key, { titel, text });
  const paket = await paketPacken(key, meinJwk, notizKontext(id, 1, self.id, self.id));
  notizSchluessel.set(id, { fassung: 1, key });

  const requestId = neueRequestId();
  const antwort = await anfrageSenden({ t: 'notiz:anlegen', requestId, id, chiffrat, paket });
  if (antwort.t !== 'notiz:erstellt') throw new Error(txt('fehler.keineAntwort'));
  return antwort.notiz;
}

/* ── Speichern ─────────────────────────────────────────────────── */

/**
 * Serialisiert je Notiz: läuft schon ein Speichern, wartet der nächste
 * Aufruf, statt gleichzeitig loszuschicken — sonst könnte die Antwort auf
 * den älteren Versuch nach der auf den neueren ankommen und der Zustand
 * kurz rückwärts springen.
 */
const speichernReihe = new Map<string, Promise<unknown>>();

export async function notizSpeichern(
  notizId: string, titel: string, text: string, force = false,
): Promise<{ ok: true } | { ok: false; server: Notiz }> {
  const notiz = useStore.getState().notizen[notizId];
  if (!notiz) throw new Error(txt('fehler.notizNichtGefunden'));
  // Der Stand, gegen den geprüft wird, steht hier fest — ein für alle Mal für
  // diesen Aufruf, nicht bei jedem stillen Wiederholungsversuch neu gelesen.
  // Läse versuchSpeichern() ihn jedes Mal frisch aus dem Zustand, könnte ein
  // Wiederholungsversuch nach einem Schlüsselwechsel eine INZWISCHEN von
  // jemand anderem gespeicherte Änderung für den eigenen, älteren Stand
  // halten und sie stillschweigend überschreiben — genau das, was diese Datei
  // verhindern soll (DIE FALLEN, Punkt 2).
  const basisVersion = notiz.version;

  const vorherige = speichernReihe.get(notizId) ?? Promise.resolve();
  const lauf = vorherige.catch(() => undefined)
    .then(() => versuchSpeichern(notizId, titel, text, basisVersion, force, 0));
  speichernReihe.set(notizId, lauf);
  try {
    const ergebnis = await lauf;
    // Hier und nur hier wird notizKonflikte gesetzt bzw. geräumt — nachdem
    // feststeht, ob es sich um einen echten Konflikt handelt oder um einen
    // der stillen Fälle, die versuchSpeichern() schon selbst gelöst hat.
    useStore.setState((s) => {
      if (ergebnis.ok) {
        if (!(notizId in s.notizKonflikte)) return {};
        const notizKonflikte = { ...s.notizKonflikte }; delete notizKonflikte[notizId];
        return { notizKonflikte };
      }
      return { notizKonflikte: { ...s.notizKonflikte, [notizId]: ergebnis.server } };
    });
    return ergebnis;
  } finally {
    if (speichernReihe.get(notizId) === lauf) speichernReihe.delete(notizId);
  }
}

async function versuchSpeichern(
  notizId: string, titel: string, text: string, basisVersion: number, force: boolean, versuch: number,
): Promise<{ ok: true } | { ok: false; server: Notiz }> {
  const eintrag = notizSchluessel.get(notizId);
  if (!eintrag) throw new Error(txt('fehler.notizSchluesselFehlt'));

  const chiffrat = await inhaltVerschluesseln(eintrag.fassung, eintrag.key, { titel, text });
  const requestId = neueRequestId();
  const antwort = await anfrageSenden({
    t: 'notiz:speichern', requestId, notizId, chiffrat, version: basisVersion, force,
  });

  if (antwort.t === 'notiz:upsert') return { ok: true };
  if (antwort.t !== 'notiz:konflikt') throw new Error(txt('fehler.keineAntwort'));

  /* Zwei ganz verschiedene Gründe stecken in derselben Meldung, siehe
     services/notizen.ts (speichern()): weicht NUR die Fassung vom eigenen
     Versuch ab, aber der Inhaltsstand ist noch derselbe, von dem dieser
     Aufruf ausging, hat jemand den Notizschlüssel gewechselt, während diese
     App noch mit dem alten verschlüsselt hat — ein rein technischer
     Wettlauf, den die App still selbst auflöst. Weicht der Inhaltsstand vom
     eigenen ab — ob dabei auch die Fassung wechselte oder nicht —, hat ein
     MENSCH zwischenzeitlich gespeichert. Das gehört vor eine Person, nicht
     in eine automatische Wiederholung. */
  const nurStillerWettlauf = antwort.aktuell.version === basisVersion
    && antwort.aktuell.schluesselFassung !== eintrag.fassung;
  if (nurStillerWettlauf && versuch < 4) {
    // Der neue Schlüssel trifft über notiz:schluessel praktisch sofort ein
    // (derselbe Vorgang, der die Fassung gerade erst gewechselt hat) — kurz
    // warten reicht, ein Nachfragen beim Server braucht es dafür nicht.
    for (let i = 0; i < 20; i++) {
      if (notizSchluessel.get(notizId)?.fassung === antwort.aktuell.schluesselFassung) break;
      await new Promise((r) => setTimeout(r, 100));
    }
    return versuchSpeichern(notizId, titel, text, basisVersion, force, versuch + 1);
  }
  return { ok: false, server: antwort.aktuell };
}

/* ── Mitglieder ────────────────────────────────────────────────── */

export async function notizMitgliedHinzufuegen(notizId: string, zielUserId: string): Promise<void> {
  const notiz = useStore.getState().notizen[notizId];
  if (!notiz) throw new Error(txt('fehler.notizNichtGefunden'));
  const eintrag = notizSchluessel.get(notizId);
  if (!eintrag) throw new Error(txt('fehler.notizSchluesselFehlt'));

  await schluesselAnfordern([zielUserId]);
  const zielJwk = fremderOeffentlicherSchluessel(zielUserId);
  if (!zielJwk) throw new Error(txt('fehler.absenderSchluesselFehlt'));

  const self = useStore.getState().self;
  if (!self) throw new Error(txt('fehler.keineVerbindung'));
  const paket = await paketPacken(eintrag.key, zielJwk, notizKontext(notizId, eintrag.fassung, self.id, zielUserId));
  socket.send({ t: 'notiz:mitglied-hinzufuegen', notizId, userId: zielUserId, paket });
}

/**
 * Entfernen UND den Notizschlüssel wechseln — siehe services/notizen.ts,
 * mitgliedEntfernen() für die Begründung, warum das in einem Schritt von
 * hier aus passiert statt von einer Absprache unter den Mitgliedern.
 */
export async function notizMitgliedEntfernen(notizId: string, zielUserId: string): Promise<void> {
  for (let versuch = 0; versuch < 4; versuch++) {
    const notiz = useStore.getState().notizen[notizId];
    if (!notiz) throw new Error(txt('fehler.notizNichtGefunden'));
    // Nicht direkt aus dem Zustand gelesen: notizenKlartext[id] kann für
    // einen kurzen Augenblick noch den vorigen Inhalt tragen, während
    // notizen[id].version schon weiter ist (siehe decodiereUndSpeichere).
    // Ein Entfernen auf Grundlage dieses veralteten Inhalts verschlossene das
    // gerade erst gespeicherte Neue wieder unter dem gewechselten Schlüssel —
    // lautlos, und genau das darf hier nicht passieren.
    const klartext = await klartextFuerVersionWarten(notizId, notiz.version);
    if (!klartext) throw new Error(txt('fehler.notizSchluesselFehlt'));
    const self = useStore.getState().self;
    if (!self) throw new Error(txt('fehler.keineVerbindung'));

    const bleibende = [notiz.ownerId, ...notiz.memberIds].filter((id) => id !== zielUserId);
    await schluesselAnfordern(bleibende);

    const neuerSchluessel = await crypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, true, ['encrypt', 'decrypt']);
    const neueFassung = notiz.schluesselFassung + 1;
    const chiffrat = await inhaltVerschluesseln(neueFassung, neuerSchluessel, klartext);

    const pakete: { userId: string; paket: SchluesselPaket }[] = [];
    for (const uid of bleibende) {
      const jwk = uid === self.id ? eigenerOeffentlicherSchluessel() : fremderOeffentlicherSchluessel(uid);
      if (!jwk) continue; // ohne Schlüssel dieser Person lässt sich für sie nichts verpacken
      pakete.push({ userId: uid, paket: await paketPacken(neuerSchluessel, jwk, notizKontext(notizId, neueFassung, self.id, uid)) });
    }

    const requestId = neueRequestId();
    let antwort: ServerEvent;
    try {
      antwort = await anfrageSenden({
        t: 'notiz:mitglied-entfernen', requestId, notizId, userId: zielUserId,
        neueFassung, chiffrat, version: notiz.version, pakete,
      });
    } catch (fehler) {
      // Der servergeprüfte Wettlauf (services/notizen.ts wirft dafür seine
      // eigene, erkennbare FassungsKonflikt) kommt als gewöhnlicher Fehler
      // zurück — die Nachricht ist dieselbe, an der lässt er sich erkennen.
      if ((fehler as Error).message.includes('gewechselt') && versuch < 3) continue;
      throw fehler;
    }
    if (antwort.t === 'notiz:upsert') {
      notizSchluessel.set(notizId, { fassung: neueFassung, key: neuerSchluessel });
      return;
    }
    throw new Error(txt('fehler.keineAntwort'));
  }
}

export function notizLoeschen(notizId: string): void {
  socket.send({ t: 'notiz:loeschen', notizId });
}

/* ── Auf Ereignisse hören ──────────────────────────────────────── */

socket.onEvent((ev: ServerEvent) => {
  void verarbeiten(ev);
});

async function verarbeiten(ev: ServerEvent): Promise<void> {
  // Anfragen mit passender requestId zuerst bedienen — unabhängig davon,
  // was unten sonst noch mit demselben Ereignis passiert.
  const requestId = 'requestId' in ev ? (ev.requestId as string | undefined) : undefined;
  if (requestId) {
    const eintrag = wartend.get(requestId);
    if (eintrag) {
      wartend.delete(requestId);
      if (ev.t === 'error') eintrag.ablehnen(new Error(ev.message));
      else eintrag.aufloesen(ev);
    }
  }

  try {
    switch (ev.t) {
      case 'notiz:list':
        // Nichts wird hier vorab verworfen: ein schon entpackter Schlüssel
        // bleibt gültig, solange seine Fassung noch die aktuelle ist — das
        // prüft decodiereUndSpeichere() ohnehin bei jedem Aufruf selbst.
        useStore.setState({ notizen: Object.fromEntries(ev.notizen.map((n) => [n.id, n])), notizenGeladen: true });
        for (const n of ev.notizen) void decodiereUndSpeichere(n);
        return;

      case 'notiz:erstellt':
      case 'notiz:upsert':
        useStore.setState((s) => ({ notizen: { ...s.notizen, [ev.notiz.id]: ev.notiz } }));
        void decodiereUndSpeichere(ev.notiz);
        return;

      case 'notiz:entfernt':
        notizSchluessel.delete(ev.notizId);
        useStore.setState((s) => {
          const notizen = { ...s.notizen }; delete notizen[ev.notizId];
          const notizenKlartext = { ...s.notizenKlartext }; delete notizenKlartext[ev.notizId];
          const notizKonflikte = { ...s.notizKonflikte }; delete notizKonflikte[ev.notizId];
          return { notizen, notizenKlartext, notizKonflikte };
        });
        return;

      case 'notiz:konflikt':
        /* Den aktuellen Stand trotzdem übernehmen — sonst hätte die
           Oberfläche später, wenn sie "anderen Stand übernehmen" anbietet,
           gar nichts zum Anzeigen. Absichtlich NICHT notizKonflikte selbst
           setzen: dieses Ereignis trifft auch für die stillen, rein
           technischen Wettläufe ein, die notizSpeichern() unten automatisch
           auflöst — bekäme jeder Fall hier schon eine sichtbare Bank,
           flackerte sie bei jedem Schlüsselwechsel kurz auf, obwohl nie ein
           Mensch etwas entscheiden musste. notizSpeichern() setzt
           notizKonflikte deshalb selbst, erst nachdem feststeht, dass es kein
           stiller Fall war. */
        useStore.setState((s) => ({ notizen: { ...s.notizen, [ev.notizId]: ev.aktuell } }));
        void decodiereUndSpeichere(ev.aktuell);
        return;

      case 'notiz:schluessel': {
        const key = await paketAuspacken(ev.paket, notizKontext(ev.notizId, ev.fassung, ev.paket.von, useStore.getState().self?.id ?? ''));
        notizSchluessel.set(ev.notizId, { fassung: ev.fassung, key });
        const notiz = useStore.getState().notizen[ev.notizId];
        if (notiz) void decodiereUndSpeichere({ ...notiz, schluesselFassung: ev.fassung });
        return;
      }

      case 'notiz:pakete-fehlen': {
        // Diese Person hat gerade erst einen Schlüssel hinterlegt — jetzt
        // nachverpacken, genau wie beim ersten Hinzufügen.
        const eintrag = notizSchluessel.get(ev.notizId);
        const self = useStore.getState().self;
        if (!eintrag || !self) return;
        await schluesselAnfordern([ev.userId]);
        const jwk = fremderOeffentlicherSchluessel(ev.userId);
        if (!jwk) return;
        const paket = await paketPacken(eintrag.key, jwk, notizKontext(ev.notizId, eintrag.fassung, self.id, ev.userId));
        socket.send({ t: 'notiz:pakete-nachreichen', notizId: ev.notizId, userId: ev.userId, paket });
        return;
      }

      default:
        return;
    }
  } catch (err) {
    console.warn('[notizen]', (err as Error).message);
  }
}

/** Wie viele der geladenen Notizen dieses Gerät gerade lesen kann — für Anzeigen. */
export function lesbareNotizen(): number {
  const klartexte = useStore.getState().notizenKlartext;
  return Object.values(klartexte).filter((k) => k !== null).length;
}
