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
import {
  hatKontoSchluessel, notizKontoAuspacken, notizKontoPacken,
} from './kontoschluessel.js';

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
 *  liefert sie bei jedem Start neu.
 *
 *  `bewaehrt` heißt: mit diesem Schlüssel ließ sich das Chiffrat DIESER Notiz
 *  wirklich öffnen. Das ist der Schiedsrichter zwischen den beiden Wegen
 *  (Gerät und Konto): kommen sie je zu verschiedenen Schlüsseln, gewinnt
 *  nicht der zuletzt eingetroffene, sondern der, der die Notiz nachweislich
 *  aufmacht. Siehe DIE ZWEI WEGE weiter unten. */
const notizSchluessel = new Map<string, { fassung: number; key: CryptoKey; bewaehrt: boolean }>();

/* ── DIE ZWEI WEGE ─────────────────────────────────────────────
   Zu jedem Notizschlüssel führen zwei voneinander unabhängige Wege:

     GERÄTEWEG   ECDH mit dem privaten Teil DIESES Geräts
                 (notiz:schluessel, lib/vertraulich.ts). Alt, bewährt — und
                 genau deshalb unbrauchbar für ein ZWEITES Gerät desselben
                 Kontos: dessen privater Teil ist ein anderer.

     KONTOWEG    AES-GCM mit einem Schlüssel, den jedes Gerät des Kontos aus
                 dem Passwort herleitet (notiz:konto-paket,
                 lib/kontoschluessel.ts). Neu, und der eigentliche Grund
                 dafür, dass eine auf dem Mac angelegte Notiz sich auch auf
                 dem Handy öffnen lässt.

   Der Geräteweg wird NICHT ersetzt. Zwei Wege heißen: fällt einer aus, ist
   keine Notiz verloren.

   Sind sie sich uneinig — beide liefern einen Schlüssel, aber verschiedene —,
   entscheidet nicht das Protokoll, sondern die Notiz selbst: wer sie
   aufbekommt, hat recht (`bewaehrt` oben). Der unterlegene Kontoweg wird
   danach mit dem bewährten Schlüssel überschrieben, statt als stille
   Fehlerquelle stehen zu bleiben (siehe kontoLuecken). */

/**
 * Notizen, für die dem Server ein gültiges Kontopaket fehlt.
 *
 * Kommt als Ganzes vom Server (notiz:konto-fehlt) und wird nicht geraten:
 * nur er weiß, welche Zeilen wirklich dastehen und ob ihre Fassungen noch
 * passen. Hier steht sie, damit ein Gerät, das den Schlüssel gerade ERPROBT
 * hat, die Lücke gleich schließt — der Weg, auf dem der Altbestand
 * nachwächst.
 */
let kontoLuecken = new Set<string>();

/**
 * Eine Lücke schließen — aber nur mit einem Schlüssel, der die Notiz eben
 * WIRKLICH geöffnet hat.
 *
 * Diese Bedingung ist der Kern. Ein Kontopaket, das aus einem ungeprüften
 * Schlüssel entsteht, sähe in der Datenbank tadellos aus und ließe sich nie
 * öffnen — schlimmer als die ehrliche Lücke, die es zu schließen vorgibt,
 * weil eine Lücke sich später von selbst füllt und ein falsches Paket nie.
 * Deshalb wird von hier aus nur nach einer geglückten Entschlüsselung
 * gerufen, und nur mit genau dem Schlüssel, mit dem sie geglückt ist.
 */
async function kontoLueckeSchliessen(notizId: string, fassung: number, key: CryptoKey): Promise<void> {
  if (!kontoLuecken.has(notizId) || !hatKontoSchluessel()) return;
  kontoLuecken.delete(notizId); // erst austragen, dann senden — sonst schickt der nächste Lauf dasselbe noch einmal
  try {
    const paket = await notizKontoPacken(key, notizId, fassung);
    socket.send({ t: 'notiz:konto-paket-setzen', notizId, fassung, paket });
  } catch (err) {
    kontoLuecken.add(notizId); // hat nicht geklappt — beim nächsten Mal wieder versuchen
    console.warn('[notizen] Kontopaket nachtragen:', (err as Error).message);
  }
}

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
    // Kann sich in Minuten von selbst lösen (ein anderes Gerät verpackt
    // nach) oder nie — schluesselWartenStarten() setzt die Grenze, ab der
    // die Oberfläche das eine vom anderen unterscheidet.
    schluesselWartenStarten(notiz.id);
    return;
  }
  // Die richtige Fassung liegt vor — was als Nächstes fehlschlägt (siehe
  // inhaltEntschluesseln), ist ein beschädigtes Chiffrat, kein fehlender
  // Schlüssel mehr. Deshalb hier auflösen, nicht erst nach dem Entschlüsseln.
  schluesselWartenAufloesen(notiz.id);
  const inhalt = await inhaltEntschluesseln(eintrag.key, notiz.chiffrat);
  if (inhalt) {
    // Ab hier ist dieser Schlüssel kein Kandidat mehr, sondern belegt.
    eintrag.bewaehrt = true;
    void kontoLueckeSchliessen(notiz.id, eintrag.fassung, eintrag.key);
  }
  useStore.setState((s) => ({
    notizenKlartext: {
      ...s.notizenKlartext,
      [notiz.id]: inhalt ? { ...inhalt, version: notiz.version } : null,
    },
  }));
}

/**
 * Wie lange die Oberfläche einen fehlenden Notizschlüssel als „kommt noch"
 * statt als „kommt nicht mehr" behandelt.
 *
 * Großzügig genug für den vollen Umweg, den notiz:pakete-fehlen und
 * notiz:pakete-nachreichen brauchen (ein anderes Gerät muss online sein,
 * seinen eigenen Schlüssel laden — notfalls erst vom Server nachladen, siehe
 * eigenenNotizSchluesselNachladen() —, den fremden öffentlichen Teil holen,
 * verpacken und zurückschicken), knapp genug, dass eine Person nicht
 * unnötig lang vor einem stummen Kreisel sitzt.
 *
 * Über `globalThis.__NOTIZ_SCHLUESSEL_WARTEZEIT_MS__` von außen verkürzbar —
 * ausschließlich für scripts/notiz-schluessel-nachreichen-pruefen.mjs, das
 * sonst auf einen echten 15-Sekunden-Ablauf warten müsste, um den
 * Fehlzustand zu erreichen. Derselbe Kniff wie
 * `__VERSCHLUESSELN_SCHEITERT__` in scripts/nachricht-fehler-zuordnung-
 * pruefen.mjs.
 */
function schluesselWartezeitMs(): number {
  const ueberschrieben = (globalThis as { __NOTIZ_SCHLUESSEL_WARTEZEIT_MS__?: number }).__NOTIZ_SCHLUESSEL_WARTEZEIT_MS__;
  return typeof ueberschrieben === 'number' ? ueberschrieben : 15_000;
}

/** Zeitgeber je Notiz, die gerade auf ihren Schlüssel wartet. */
const schluesselWartezeit = new Map<string, number>();

function schluesselWartenStarten(notizId: string): void {
  if (schluesselWartezeit.has(notizId)) return; // läuft schon
  const timer = window.setTimeout(() => {
    schluesselWartezeit.delete(notizId);
    useStore.setState((s) => ({ notizenSchluesselFehlt: { ...s.notizenSchluesselFehlt, [notizId]: true } }));
  }, schluesselWartezeitMs());
  schluesselWartezeit.set(notizId, timer);
}

/** Den Zeitgeber abbrechen und eine schon gezeigte Fehlmeldung zurücknehmen
 *  — der Schlüssel ist (wieder) da, oder die Notiz ist weg. */
function schluesselWartenAufloesen(notizId: string): void {
  const timer = schluesselWartezeit.get(notizId);
  if (timer !== undefined) { window.clearTimeout(timer); schluesselWartezeit.delete(notizId); }
  useStore.setState((s) => {
    if (!(notizId in s.notizenSchluesselFehlt)) return {};
    const notizenSchluesselFehlt = { ...s.notizenSchluesselFehlt }; delete notizenSchluesselFehlt[notizId];
    return { notizenSchluesselFehlt };
  });
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

/**
 * Den eigenen Notizschlüssel nachladen, ohne dass die Notiz vorher auf
 * diesem Gerät geöffnet worden wäre.
 *
 * notizSchluessel (oben) füllt sich sonst ausschließlich, während die Tafel
 * offen ist: notiz:list löst dort für jede eigene Notiz ein eigenes
 * notiz:schluessel aus (siehe case 'notiz:list' unten und paketeFuerAlle()
 * auf dem Server). Ein Gerät, das zwar verbunden, dessen Tafel seit dem
 * Start aber nie offen war, hat also nichts im Speicher — obwohl das eigene
 * Paket beim Server längst liegt (aus notizErstellen() oder einem früheren
 * notiz:mitglied-hinzufuegen). notiz:list einfach noch einmal zu schicken
 * holt genau das nach, für alle eigenen Notizen auf einmal — bei der
 * überschaubaren Zahl eigener Notizen kein Gewicht.
 *
 * Kein eigenes Anfrage/Antwort-Paar dafür: notiz:list trägt keine
 * requestId (sie kommt beim Tafel-Öffnen ungebeten), deshalb wird hier
 * stattdessen kurz auf das Ergebnis gewartet — derselbe Kniff wie
 * klartextFuerVersionWarten() weiter oben. case 'notiz:schluessel' im
 * Ereignishörer unten füllt notizSchluessel währenddessen ganz normal.
 */
async function eigenenNotizSchluesselNachladen(notizId: string): Promise<{ fassung: number; key: CryptoKey; bewaehrt: boolean } | undefined> {
  notizenAnfordern();
  for (let i = 0; i < 50; i++) {
    const eintrag = notizSchluessel.get(notizId);
    if (eintrag) return eintrag;
    await new Promise((r) => setTimeout(r, 100));
  }
  return undefined;
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
  /* Der zweite Weg gleich mit — und zwar SOFORT, nicht später nachgetragen.
     Genau dieser Augenblick war der gemeldete Fehler: eine Notiz, die auf
     dem einen Gerät entsteht, muss auf dem anderen aufgehen, ohne dass das
     erste je wieder online sein müsste. `key` ist hier zwangsläufig der
     richtige — er ist gerade in dieser Funktion entstanden und hat das
     Chiffrat zwei Zeilen darüber selbst erzeugt. */
  const kontoPaket = hatKontoSchluessel() ? await notizKontoPacken(key, id, 1) : undefined;
  notizSchluessel.set(id, { fassung: 1, key, bewaehrt: true });

  const requestId = neueRequestId();
  const antwort = await anfrageSenden({ t: 'notiz:anlegen', requestId, id, chiffrat, paket, kontoPaket });
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
      notizSchluessel.set(notizId, { fassung: neueFassung, key: neuerSchluessel, bewaehrt: true });
      /* Der Schlüsselwechsel hat alle Kontopakete dieser Notiz weggeräumt
         (services/notizen.ts) — sie trugen die alte Fassung. Das eigene
         gleich neu, sonst stünde das ZWEITE Gerät dieser Person bis zum
         nächsten Rundgang vor einer Notiz, die es eben noch lesen konnte.
         Für die übrigen Mitglieder lässt sich hier nichts packen: ihren
         Kontoschlüssel hat niemand außer ihnen. Deren Pakete wachsen über
         notiz:konto-fehlt nach. */
      if (hatKontoSchluessel()) {
        kontoLuecken.add(notizId);
        await kontoLueckeSchliessen(notizId, neueFassung, neuerSchluessel);
      }
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
        schluesselWartenAufloesen(ev.notizId); // sonst schlägt ein längst gelöschter Zeitgeber später noch zu
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
        /* Der Geräteweg. Auf einem ZWEITEN Gerät desselben Kontos schlägt er
           zwangsläufig fehl — das Paket wurde mit dem privaten Teil des
           ersten gerechnet. Das ist seit dieser Fassung kein Fehler mehr,
           sondern der erwartete Normalfall, und es wäre eine Warnung je Notiz
           und Sitzung: deshalb still übergehen, sofern der Kontoweg schon
           einen Schlüssel geliefert hat. */
        const vorhanden = notizSchluessel.get(ev.notizId);
        let key: CryptoKey;
        try {
          key = await paketAuspacken(ev.paket, notizKontext(ev.notizId, ev.fassung, ev.paket.von, useStore.getState().self?.id ?? ''));
        } catch (err) {
          if (vorhanden?.fassung === ev.fassung) return;
          throw err;
        }
        // Ein bewährter Schlüssel derselben Fassung wird nicht verdrängt —
        // siehe DIE ZWEI WEGE oben.
        if (!(vorhanden?.fassung === ev.fassung && vorhanden.bewaehrt)) {
          notizSchluessel.set(ev.notizId, { fassung: ev.fassung, key, bewaehrt: false });
        }
        const notiz = useStore.getState().notizen[ev.notizId];
        if (notiz) void decodiereUndSpeichere({ ...notiz, schluesselFassung: ev.fassung });
        return;
      }

      case 'notiz:konto-fehlt':
        // Vollbild vom Server, kein Zuwachs — was hier NICHT drinsteht, hat
        // ein gültiges Kontopaket und braucht keines mehr.
        kontoLuecken = new Set(ev.notizIds);
        return;

      case 'notiz:konto-paket': {
        const vorhanden = notizSchluessel.get(ev.notizId);
        const key = await notizKontoAuspacken(ev.paket, ev.notizId, ev.fassung);
        if (vorhanden?.fassung === ev.fassung && vorhanden.bewaehrt) {
          /* Es liegt schon ein Schlüssel, der diese Notiz nachweislich
             aufmacht. Trägt das Kontopaket denselben, ist nichts zu tun.
             Trägt es einen ANDEREN, ist es falsch — dann darf es nicht
             stehen bleiben, sondern wird als Lücke geführt und beim nächsten
             geglückten Entschlüsseln mit dem bewährten Schlüssel
             überschrieben. */
          const [a, b] = await Promise.all([
            crypto.subtle.exportKey('raw', vorhanden.key), crypto.subtle.exportKey('raw', key),
          ]);
          const gleich = b64u(new Uint8Array(a)) === b64u(new Uint8Array(b));
          if (!gleich) {
            console.warn('[notizen] Kontopaket weicht vom bewährten Schlüssel ab, notizId', ev.notizId);
            kontoLuecken.add(ev.notizId);
            const notiz = useStore.getState().notizen[ev.notizId];
            if (notiz) void decodiereUndSpeichere(notiz);
          }
          return;
        }
        notizSchluessel.set(ev.notizId, { fassung: ev.fassung, key, bewaehrt: false });
        kontoLuecken.delete(ev.notizId);
        const notiz = useStore.getState().notizen[ev.notizId];
        if (notiz) void decodiereUndSpeichere({ ...notiz, schluesselFassung: ev.fassung });
        return;
      }

      case 'notiz:pakete-fehlen': {
        // Diese Person hat gerade erst einen Schlüssel hinterlegt (oder die
        // besitzende Person ist gerade erst wieder verbunden, siehe
        // ws/gateway.ts, ready() — derselbe Anlass, nur verspätet nachgeholt)
        // — jetzt nachverpacken, genau wie beim ersten Hinzufügen.
        const self = useStore.getState().self;
        if (!self) {
          // Kommt praktisch nicht vor (das Ereignis setzt eine angemeldete
          // Verbindung voraus), aber lieber sichtbar verworfen als still —
          // sonst sähe man später nur, dass niemand je geantwortet hat, ohne
          // zu wissen, an welcher Stelle es lag.
          console.warn('[notizen] pakete-fehlen ohne angemeldete Person, notizId', ev.notizId);
          return;
        }
        // Vorher: fehlte der Eintrag hier (weil diese Notiz auf diesem Gerät
        // seit dem Start nie geöffnet wurde), gab die Funktion still auf —
        // die anfragende Person wartete dann für immer, siehe DIE FALLEN.
        // eigenenNotizSchluesselNachladen() holt das eigene, längst beim
        // Server liegende Paket nach, ohne dass die Notiz je offen gewesen
        // sein müsste.
        let eintrag = notizSchluessel.get(ev.notizId);
        if (!eintrag) eintrag = await eigenenNotizSchluesselNachladen(ev.notizId);
        if (!eintrag) {
          console.warn(
            '[notizen] pakete-fehlen: eigener Notizschlüssel nicht verfügbar, notizId', ev.notizId,
            'für', ev.userId, '— dieses Gerät kann nicht nachverpacken.',
          );
          return;
        }
        await schluesselAnfordern([ev.userId]);
        const jwk = fremderOeffentlicherSchluessel(ev.userId);
        if (!jwk) {
          console.warn('[notizen] pakete-fehlen: kein öffentlicher Schlüssel für', ev.userId, '— nichts zu verpacken.');
          return;
        }
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
