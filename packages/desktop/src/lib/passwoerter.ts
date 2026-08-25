import {
  nutzlastLesen, nutzlastSchreiben, type Passworteintrag, type SchluesselPaket,
} from '@stellium/shared';
import { api } from '../net/api.js';
import { useStore } from '../state/store.js';
import { spracheDesSystems, translate, type TranslationKey } from '../i18n/kern.js';
import {
  b64u, eigenerOeffentlicherSchluessel, fremderOeffentlicherSchluessel,
  habeSchluessel, paketAuspacken, paketPacken, schluesselAnfordern, unb64u,
} from './vertraulich.js';
import {
  hatKontoSchluessel, passwortKontoAuspacken, passwortKontoPacken,
} from './kontoschluessel.js';

/**
 * Der Passwort-Tresor — dieselbe Schlüsselarbeit wie lib/notizen.ts, nur für
 * Zugangsdaten statt Titel/Text, und über HTTP statt WebSocket.
 *
 * WARUM HTTP UND NICHT WEBSOCKET, ANDERS ALS BEI NOTIZEN
 *
 * Notizen brauchen einen Push (`notiz:schluessel`, `notiz:konto-paket`, …),
 * weil ein zweites Gerät sofort mitbekommen soll, wenn eine Notiz neu
 * ankommt oder ihr Schlüssel wechselt, während die Tafel gerade offen ist.
 * Der Tresor ändert sich seltener — ein neuer Eintrag, ein geteilter Zugang,
 * das war's meistens für Tage. Diese Datei fragt deshalb beim Öffnen der
 * Tafel einmal ab (`passwoerterLaden()`), genau wie PaypalPanel und
 * EinmalcodePanel es für ihre eigenen Daten tun — kein Push, keine
 * WebSocket-Ereignisverarbeitung, weniger Fläche für genau die Art Fehler,
 * die diese App unter Notizen schon einmal gemeldet bekam ("auf dem Mac
 * angelegt, auf dem Handy nie angekommen").
 *
 * WAS UNVERÄNDERT BLEIBT: DIE KRYPTOGRAFIE
 *
 * gemeinsamerSchluessel(), paketPacken() und paketAuspacken() aus
 * lib/vertraulich.ts, passwortKontoPacken()/passwortKontoAuspacken() aus
 * lib/kontoschluessel.ts (eigener Kontext, sonst wortgleich zu den
 * Notiz-Varianten dort) — nichts davon wird hier neu erfunden. Der private
 * Schlüssel verlässt das Gerät nie, der Server bekommt vom Inhalt — auch vom
 * Etikett — nie mehr als Chiffrat zu sehen.
 *
 * ZWEI HÜLLEN — DER KERN DIESER DATEI
 *
 * Ein Eintrag steckt nicht mehr in EINER Hülle, sondern in zweien, beide
 * unter demselben Eintragsschlüssel und derselben Schlüsselfassung:
 *
 *   · SCHAUFENSTER (`PasswortSchaufenster`): Etikett, Benutzername, Notiz,
 *     Adresse, Einmalcode-Verknüpfung. Das holt `passwoerterLaden()` beim
 *     Öffnen der Tafel für alles Sichtbare — wie vorher, nur ohne Passwort.
 *   · GEHEIMNIS: das Passwort, sonst nichts. Das holt ausschließlich
 *     `passwortGeheimnisHolen()`, einzeln, je Eintrag, je Anlass — und der
 *     Server schreibt beim Ausliefern eine Offenlegungszeile.
 *
 * WARUM NICHT EINFACH "ERST BEIM AUSWÄHLEN ENTSCHLÜSSELN". Weil die LISTE
 * Etiketten zeigt und das Etikett in derselben Hülle lag wie das Passwort:
 * was die Liste braucht, musste sie schon aufgemacht haben. Ohne die
 * Trennung hätte ein späteres Entschlüsseln nichts gewonnen — es wäre
 * dieselbe Hülle, nur ein paar Millisekunden später.
 *
 * WARUM DAS GEHEIMNIS AUFGEFÜLLT WIRD (`GEHEIM_BLOCK` unten). Eine Hülle um
 * nur das Passwort wäre so lang wie das Passwort. Der Server hätte durch die
 * Trennung also etwas ERFAHREN, das er aus der einen gemeinsamen Hülle nie
 * herauslesen konnte. Das wäre ein schlechter Tausch, und deshalb wird der
 * Klartext vorher auf ein Vielfaches von 256 Byte aufgefüllt.
 *
 * DIE FÜNF UNVERHANDELBAREN PUNKTE DES AUFTRAGS, UND WO SIE HIER STEHEN:
 *   1. Kein Passwort verlässt je die verschlüsselte Zone — diese Datei gibt
 *      Klartext ausschließlich an den aufrufenden Zustand der Oberfläche
 *      zurück (nie an console.*, nie an einen Toast, nie an den Server).
 *   2. Suche läuft auf dem Gerät — siehe PasswortPanel.tsx: gefiltert wird
 *      über `schaufenster`, nie über eine Anfrage an den Server. Über den
 *      Passwortwert wurde nie gesucht; jetzt liegt er dafür auch gar nicht
 *      mehr vor.
 *   3. Aufdecken ist eine bewusste Handlung — und seit der Trennung nicht
 *      mehr nur der Höflichkeit nach: `passwoerterLaden()` entschlüsselt
 *      kein einziges Passwort, und `passwortGeheimnisHolen()` bekommt keines
 *      ohne die Zeile, die der Server dabei schreibt.
 *   4. Kopieren löscht sich selbst — `kopierenUndLoeschen()` unten. Kopieren
 *      holt das Geheimnis eigens, auch wenn es gerade aufgedeckt ist: es ist
 *      ein zweiter Weg an den Wert und wird wie der erste vermerkt.
 *   5. Der Server bleibt außen vor — jede Funktion hier verschlüsselt/
 *      entschlüsselt ausschließlich lokal; der Server sieht nur `chiffrat`,
 *      `iv`, `daten`, niemals einen Schlüssel oder einen Klartext.
 */

function txt(key: TranslationKey, werte?: Record<string, string | number>): string {
  return translate(useStore.getState().self?.uiLanguage || spracheDesSystems(), key, werte);
}

const enc = new TextEncoder();
const dec = new TextDecoder();

/** Kontext eines Tresorpakets — eigenes Präfix, damit dieselbe ECDH-Rechnung
 *  nie mit einem Notiz- oder Kanalpaket verwechselt werden kann. */
function eintragKontext(eintragId: string, fassung: number, von: string, fuer: string): string {
  return `stellium/passworttresor/${eintragId}/${fassung}/${von}>${fuer}`;
}

function neueEintragId(): string {
  return `pw_${crypto.randomUUID().replace(/-/g, '')}`;
}

/** Was die LISTE braucht — und ausdrücklich kein Passwort. `totpKontoId`
 *  verweist auf ein Konto in einmalcode_konten (siehe state/einmalcode.ts) —
 *  eine reine Bequemlichkeits-Verknüpfung ohne eigene Prüfung: wer die
 *  Kennung nicht (mehr) sehen darf, bekommt beim Öffnen des
 *  Einmalcode-Reiters ohnehin dessen eigene Rechteschranke zu spüren
 *  (`einmalcode.nutzen`).
 *
 *  Benutzername und Notiz stehen bewusst HIER und nicht im Geheimnis: die
 *  Tafel zeigt beide seit jeher offen, sucht über beide und kopiert den
 *  Benutzernamen ohne Vermerk. Sie ins Geheimnis zu ziehen hieße, drei
 *  Dinge auf einmal zu ändern und die Suche zu verlieren. Was das kostet,
 *  steht im Kopf von server/services/passwoerter.ts — eine
 *  Wiederherstellungsangabe in der Notiz liegt im Schaufenster. */
export interface PasswortSchaufenster {
  label: string;
  benutzername: string;
  notiz: string;
  url: string;
  totpKontoId: string | null;
}

export function leeresSchaufenster(): PasswortSchaufenster {
  return { label: '', benutzername: '', notiz: '', url: '', totpKontoId: null };
}

/**
 * Auf wie viele Byte der Geheimnis-Klartext aufgefüllt wird.
 *
 * Ohne das verriete die Länge des Chiffrats die Länge des Passworts — an den
 * Server, an jeden, der die Datenbank sieht, und an jeden, der nur die
 * Antwortgröße misst. Aus der einen gemeinsamen Hülle war das nie
 * herauszulesen (dort addierten sich Etikett, Notiz und Adresse dazu), die
 * Trennung hätte es also ERST GESCHAFFEN. 256 Byte: großzügig über jedem
 * vernünftigen Passwort, klein genug, dass es niemandem auffällt.
 *
 * Aufgefüllt wird mit Leerzeichen HINTER dem JSON — `JSON.parse()` überliest
 * die von sich aus, es braucht also kein Feld dafür und kein Abschneiden
 * beim Lesen.
 */
const GEHEIM_BLOCK = 256;

function geheimKlartext(passwort: string): Uint8Array<ArrayBuffer> {
  const roh = enc.encode(JSON.stringify({ passwort }));
  const laenge = Math.max(GEHEIM_BLOCK, Math.ceil(roh.length / GEHEIM_BLOCK) * GEHEIM_BLOCK);
  const voll = new Uint8Array(new ArrayBuffer(laenge)).fill(0x20);
  voll.set(roh, 0);
  return voll;
}

async function huelleVerschluesseln(fassung: number, key: CryptoKey, klar: BufferSource): Promise<string> {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const daten = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, klar);
  return nutzlastSchreiben({ fassung, iv: b64u(iv), daten: b64u(daten) });
}

async function huelleLesen(key: CryptoKey, roh: string): Promise<Record<string, unknown> | null> {
  const nutzlast = nutzlastLesen(roh);
  if (!nutzlast) return null;
  try {
    const klar = await crypto.subtle.decrypt(
      { name: 'AES-GCM', iv: unb64u(nutzlast.iv) }, key, unb64u(nutzlast.daten),
    );
    return JSON.parse(dec.decode(klar)) as Record<string, unknown>;
  } catch {
    return null;
  }
}

/** Aus einer beliebigen entschlüsselten Hülle das Schaufenster herausziehen.
 *  Die Feldliste ist ABSCHLIESSEND und das ist der Zweck: kommt hier je eine
 *  alte Hülle mit `passwort` durch, fällt der Wert hier heraus statt in den
 *  Zustand der Oberfläche zu wandern. */
function schaufensterAus(roh: Record<string, unknown>): PasswortSchaufenster {
  return {
    label: typeof roh.label === 'string' ? roh.label : '',
    benutzername: typeof roh.benutzername === 'string' ? roh.benutzername : '',
    notiz: typeof roh.notiz === 'string' ? roh.notiz : '',
    url: typeof roh.url === 'string' ? roh.url : '',
    totpKontoId: typeof roh.totpKontoId === 'string' ? roh.totpKontoId : null,
  };
}

const schaufensterVerschluesseln = (fassung: number, key: CryptoKey, s: PasswortSchaufenster) =>
  huelleVerschluesseln(fassung, key, enc.encode(JSON.stringify(s)));

const geheimnisVerschluesseln = (fassung: number, key: CryptoKey, passwort: string) =>
  huelleVerschluesseln(fassung, key, geheimKlartext(passwort));

/** Entschlüsselte Eintragsschlüssel, nur im Speicher — wie notizSchluessel in
 *  lib/notizen.ts: auf der Platte bleiben nur Pakete, der Server liefert sie
 *  bei jedem Öffnen der Tafel neu. */
const eintragSchluessel = new Map<string, { fassung: number; key: CryptoKey }>();

/** Ob dieses Gerät gerade den Eintragsschlüssel eines bestimmten Eintrags im
 *  Speicher hat — für die Oberfläche, ohne den Schlüssel selbst preiszugeben. */
export function eintragLesbar(eintragId: string): boolean {
  return eintragSchluessel.has(eintragId);
}

/**
 * Alles vergessen, was zum Konto gehört — beim Abmelden.
 *
 * `eintragSchluessel` sind entpackte Eintragsschlüssel des Passworttresors:
 * mit ihnen ließe sich jedes gespeicherte Geheimnis des abgemeldeten Kontos
 * wiederherstellen, solange sie im Speicher stehen. Meldet sich auf demselben
 * Fenster ein anderes Konto an, gehören diese Schlüssel ihm nicht — dieselbe
 * Überlegung wie bei notizenVergessen() in lib/notizen.ts. Beim nächsten
 * Öffnen der Tafel liefert der Server die Pakete neu.
 */
export function passwoerterVergessen(): void {
  eintragSchluessel.clear();
}

/* ── Laden ─────────────────────────────────────────────────────── */

export interface PasswortLadeErgebnis {
  eintraege: Passworteintrag[];
  /** `null` heißt: dieses Gerät kann das Schaufenster (noch) nicht
   *  aufmachen — entweder fehlt der Schlüssel, oder der Eintrag ist
   *  Altbestand und der Server liefert seine Hülle aus gutem Grund nicht
   *  über die Liste (sie enthielte ein Passwort). Nie eine Fehlermeldung,
   *  siehe decodiereUndSpeichere() in lib/notizen.ts für denselben Gedanken.
   *
   *  EIN PASSWORT STEHT HIER AN KEINER STELLE, in keinem Feld, auch nicht
   *  leer — `PasswortSchaufenster` hat gar kein solches Feld. */
  schaufenster: Record<string, PasswortSchaufenster | null>;
}

/**
 * Alle sichtbaren Einträge laden und so weit entschlüsseln, wie es mit dem
 * geht, was dieses Gerät gerade hat.
 *
 * Reihenfolge je Eintrag: zuerst ein schon im Speicher bewährter Schlüssel
 * (spart Arbeit bei einem erneuten Aufruf während dieselbe Tafel offen
 * ist), dann der Geräteweg (ECDH), zuletzt der Kontoweg — dieselbe
 * Rangfolge wie in lib/notizen.ts, nur ohne den dortigen Wettstreit über
 * Zeit: hier treffen beide Wege in EINEM Aufruf ein, nicht nacheinander per
 * Ereignis, ein Vorrang genügt.
 *
 * Zwei Nacharbeiten laufen im selben Aufruf mit, für Einträge, die man
 * selbst besitzt: eine fehlende Kontopaket-Zeile für sich selbst wird
 * nachgetragen (derselbe Fund wie bei Notizen: sonst bleibt ein zweites
 * Gerät desselben Kontos außen vor), und ein Mitglied, für das noch kein
 * ECDH-Paket existiert, weil sein öffentlicher Teil beim Teilen fehlte,
 * bekommt jetzt eines — vorausgesetzt, sein öffentlicher Teil ist inzwischen
 * da.
 */
export async function passwoerterLaden(): Promise<PasswortLadeErgebnis> {
  const antwort = await api.passwortListe();
  const self = useStore.getState().self;

  const eigenePaketeVon = new Map(antwort.eigenePakete.map((p) => [p.eintragId, p]));
  const kontoPaketeVon = new Map(antwort.kontoPakete.map((p) => [p.eintragId, p]));

  // Jeden Absender, dessen Paket gebraucht wird, in EINEM Rutsch anfordern
  // statt je Eintrag einzeln — derselbe Gedanke wie kanalSchluessel-Rutsch
  // in lib/vertraulich.ts (case 'vertraulich:paket').
  const absenderIds = [...new Set(antwort.eigenePakete.map((p) => p.paket.von))];
  if (absenderIds.length) await schluesselAnfordern(absenderIds);

  const schaufenster: Record<string, PasswortSchaufenster | null> = {};
  for (const eintrag of antwort.eintraege) {
    let key: CryptoKey | null = null;

    const vorhanden = eintragSchluessel.get(eintrag.id);
    if (vorhanden && vorhanden.fassung === eintrag.schluesselFassung) key = vorhanden.key;

    if (!key) {
      const p = eigenePaketeVon.get(eintrag.id);
      if (p && p.fassung === eintrag.schluesselFassung) {
        try {
          key = await paketAuspacken(p.paket, eintragKontext(eintrag.id, p.fassung, p.paket.von, self?.id ?? ''));
        } catch { /* Geräteweg schlägt fehl — Kontoweg versucht es gleich noch */ }
      }
    }

    if (!key && hatKontoSchluessel()) {
      const kp = kontoPaketeVon.get(eintrag.id);
      if (kp && kp.fassung === eintrag.schluesselFassung) {
        try {
          key = await passwortKontoAuspacken(kp.paket, eintrag.id, kp.fassung);
        } catch { /* auch der Kontoweg hat (noch) nichts Brauchbares */ }
      }
    }

    if (key) {
      eintragSchluessel.set(eintrag.id, { fassung: eintrag.schluesselFassung, key });
      /* Beim Altbestand ist `chiffrat` leer — der Server reicht die alte
         Hülle nicht über die Liste heraus. Es gibt hier also nichts zu
         entschlüsseln, und genau das ist die Zusage: das Öffnen der Tafel
         macht keine einzige Hülle auf, in der ein Passwort steckt. Umgestellt
         wird der Eintrag später, beim Auswählen (passwortUmstellen()). */
      const roh = eintrag.chiffrat ? await huelleLesen(key, eintrag.chiffrat) : null;
      schaufenster[eintrag.id] = roh ? schaufensterAus(roh) : null;

      if (antwort.kontoLuecken.includes(eintrag.id) && hatKontoSchluessel()) {
        try {
          const paket = await passwortKontoPacken(key, eintrag.id, eintrag.schluesselFassung);
          await api.passwortKontoPaketSetzen(eintrag.id, eintrag.schluesselFassung, paket);
        } catch (err) {
          console.warn('[passwoerter] Kontopaket nachtragen:', (err as Error).message);
        }
      }
    } else {
      schaufenster[eintrag.id] = null;
    }
  }

  // Nachreichen — nur für Einträge, die man selbst besitzt (istBesitzer prüft
  // der Server ohnehin noch einmal, siehe services/passwoerter.ts).
  for (const { eintragId, userId } of antwort.unverpackteMitglieder) {
    const schluessel = eintragSchluessel.get(eintragId);
    if (!schluessel) continue;
    try {
      await schluesselAnfordern([userId]);
      const jwk = fremderOeffentlicherSchluessel(userId);
      if (!jwk) continue; // ihr öffentlicher Teil ist immer noch nicht da — nächstes Mal wieder versuchen
      const paket = await paketPacken(schluessel.key, jwk, eintragKontext(eintragId, schluessel.fassung, self?.id ?? '', userId));
      await api.passwortPaketeNachreichen(eintragId, userId, paket);
    } catch (err) {
      console.warn('[passwoerter] Mitgliedspaket nachreichen:', (err as Error).message);
    }
  }

  return { eintraege: antwort.eintraege, schaufenster };
}

/* ── Anlegen ───────────────────────────────────────────────────── */

export async function passwortErstellen(
  inhalt: PasswortSchaufenster = leeresSchaufenster(), passwort = '',
): Promise<Passworteintrag> {
  if (!habeSchluessel()) throw new Error(txt('fehler.keinSchluesselpaar'));
  const meinJwk = eigenerOeffentlicherSchluessel();
  if (!meinJwk) throw new Error(txt('fehler.keinSchluesselpaar'));
  const self = useStore.getState().self;
  if (!self) throw new Error(txt('fehler.keineVerbindung'));

  const id = neueEintragId();
  const key = await crypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, true, ['encrypt', 'decrypt']);
  const chiffrat = await schaufensterVerschluesseln(1, key, inhalt);
  /* Ein neuer Eintrag bekommt sein Geheimnis SOFORT mit, auch wenn das
     Passwort noch leer ist. Sonst entstünde ein Eintrag als Altbestand und
     bräuchte eine Umstellung, die er nie nötig hatte. */
  const geheimChiffrat = await geheimnisVerschluesseln(1, key, passwort);
  const paket = await paketPacken(key, meinJwk, eintragKontext(id, 1, self.id, self.id));
  const kontoPaket = hatKontoSchluessel() ? await passwortKontoPacken(key, id, 1) : undefined;
  eintragSchluessel.set(id, { fassung: 1, key });

  const { eintrag } = await api.passwortAnlegen({ id, chiffrat, geheimChiffrat, paket, kontoPaket });
  return eintrag;
}

/* ── Speichern ─────────────────────────────────────────────────── */

/**
 * `passwort` ist ABSICHTLICH auswählbar und im Alltag nicht gesetzt.
 *
 * Wer nur das Etikett ändert, hat das Geheimnis nie geholt — dann darf und
 * soll dieser Aufruf das gespeicherte Geheimnis unangetastet lassen, statt
 * einen leeren Wert darüberzuschreiben. Genau das war die Falle beim
 * Umbauen: ein Passwortfeld, das mit '' vorbelegt ist und beim nächsten
 * automatischen Speichern das echte Passwort löscht. Deshalb bedeutet
 * `undefined` hier "nicht angefasst" und '' bedeutet "wirklich leer".
 */
export async function passwortSpeichern(
  eintragId: string, inhalt: PasswortSchaufenster, version: number, force = false,
  passwort?: string,
): Promise<{ ok: true; eintrag: Passworteintrag } | { ok: false; eintrag: Passworteintrag }> {
  const schluessel = eintragSchluessel.get(eintragId);
  if (!schluessel) throw new Error(txt('fehler.passwortSchluesselFehlt'));
  const chiffrat = await schaufensterVerschluesseln(schluessel.fassung, schluessel.key, inhalt);
  const geheimChiffrat = passwort === undefined
    ? undefined
    : await geheimnisVerschluesseln(schluessel.fassung, schluessel.key, passwort);
  return api.passwortSpeichern(eintragId, chiffrat, version, force, geheimChiffrat);
}

/* ── Teilen ────────────────────────────────────────────────────── */

export async function passwortTeilen(eintragId: string, zielUserId: string): Promise<Passworteintrag> {
  const schluessel = eintragSchluessel.get(eintragId);
  if (!schluessel) throw new Error(txt('fehler.passwortSchluesselFehlt'));
  const self = useStore.getState().self;
  if (!self) throw new Error(txt('fehler.keineVerbindung'));

  await schluesselAnfordern([zielUserId]);
  const zielJwk = fremderOeffentlicherSchluessel(zielUserId);
  if (!zielJwk) throw new Error(txt('fehler.absenderSchluesselFehlt'));

  const paket = await paketPacken(schluessel.key, zielJwk, eintragKontext(eintragId, schluessel.fassung, self.id, zielUserId));
  const { eintrag } = await api.passwortMitgliedHinzufuegen(eintragId, zielUserId, paket);
  return eintrag;
}

/**
 * Entfernen UND den Eintragsschlüssel wechseln, in einem Schritt — dieselbe
 * Begründung wie notizMitgliedEntfernen() in lib/notizen.ts: nur die
 * besitzende Person hat den Schlüssel ohnehin in der Hand, eine Absprache
 * unter den verbleibenden Mitgliedern (wie bei vertraulichen Kanälen) wäre
 * hier unnötige Komplexität.
 *
 * `inhalt` kommt von der aufrufenden Stelle statt hier neu entschlüsselt zu
 * werden: die Oberfläche hat ihn ohnehin schon im Bearbeitungsformular, und
 * ein zweiter Entschlüsselungslauf hier böte nur eine zweite Gelegenheit,
 * einen zwischenzeitlich gespeicherten Stand zu verpassen.
 *
 * DAS PASSWORT DAGEGEN WIRD HIER GEHOLT, nicht übergeben. Ein Schlüssel-
 * wechsel muss BEIDE Hüllen neu verpacken; bliebe das Geheimnis unter der
 * alten Fassung stehen, wäre der Eintrag hinterher halb lesbar und niemand
 * merkte es, bis das Passwort gebraucht wird. Dieses Holen ist eine
 * Aushändigung wie jede andere und steht danach im Verlauf — auch das ist
 * richtig so: wer jemanden ausschließt, hat das Passwort in der Hand gehabt.
 */
export async function passwortMitgliedEntfernen(
  eintrag: Passworteintrag, zielUserId: string, inhalt: PasswortSchaufenster,
): Promise<Passworteintrag> {
  const self = useStore.getState().self;
  if (!self) throw new Error(txt('fehler.keineVerbindung'));

  // Zuerst holen: beim Altbestand stellt das den Eintrag gleich mit um, und
  // dann sind Fassung und Version danach andere als die übergebenen.
  const { passwort, umgestellt } = await geheimnisAbrufen(eintrag);
  const stand = umgestellt?.eintrag ?? eintrag;

  const bleibende = [stand.ownerId, ...stand.memberIds].filter((id) => id !== zielUserId);
  await schluesselAnfordern(bleibende);

  const neuerSchluessel = await crypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, true, ['encrypt', 'decrypt']);
  const neueFassung = stand.schluesselFassung + 1;
  const chiffrat = await schaufensterVerschluesseln(neueFassung, neuerSchluessel, inhalt);
  const geheimChiffrat = await geheimnisVerschluesseln(neueFassung, neuerSchluessel, passwort);

  const pakete: { userId: string; paket: SchluesselPaket }[] = [];
  for (const uid of bleibende) {
    const jwk = uid === self.id ? eigenerOeffentlicherSchluessel() : fremderOeffentlicherSchluessel(uid);
    if (!jwk) continue;
    pakete.push({ userId: uid, paket: await paketPacken(neuerSchluessel, jwk, eintragKontext(stand.id, neueFassung, self.id, uid)) });
  }

  const { eintrag: neu } = await api.passwortMitgliedEntfernen(stand.id, {
    userId: zielUserId, neueFassung, chiffrat, geheimChiffrat, version: stand.version, pakete,
  });
  eintragSchluessel.set(stand.id, { fassung: neueFassung, key: neuerSchluessel });

  if (hatKontoSchluessel()) {
    try {
      const paket = await passwortKontoPacken(neuerSchluessel, eintrag.id, neueFassung);
      await api.passwortKontoPaketSetzen(eintrag.id, neueFassung, paket);
    } catch (err) {
      console.warn('[passwoerter] Kontopaket nach Entfernen:', (err as Error).message);
    }
  }
  return neu;
}

/* ── Löschen ───────────────────────────────────────────────────── */

export async function passwortLoeschen(eintragId: string): Promise<void> {
  await api.passwortLoeschen(eintragId);
  eintragSchluessel.delete(eintragId);
}

/* ── Das Geheimnis holen — und dabei den Altbestand umstellen ──────
 *
 * Die einzige Stelle in dieser App, an der ein Passwort im Klartext
 * entsteht. Sie gibt es an die aufrufende Stelle zurück und behält nichts:
 * es gibt keinen Zwischenspeicher für Geheimnisse. Das ist Absicht — ein
 * Zwischenspeicher wäre schnell wieder "beim Öffnen ist ohnehin alles da",
 * nur unter anderem Namen, und der Tresor hat eine Handvoll Einträge: eine
 * zusätzliche Anfrage je Anlass kostet nichts. */

async function geheimnisAbrufen(eintrag: Passworteintrag): Promise<{
  passwort: string;
  /** Nur beim Altbestand gesetzt: das Holen hat den Eintrag umgestellt, und
   *  die Oberfläche muss ihren Stand nachziehen. */
  umgestellt: { eintrag: Passworteintrag; schaufenster: PasswortSchaufenster } | null;
}> {
  const schluessel = eintragSchluessel.get(eintrag.id);
  if (!schluessel) throw new Error(txt('fehler.passwortSchluesselFehlt'));

  const antwort = await api.passwortGeheimnis(eintrag.id);
  /* Nicht `eintrag.altbestand` fragen, sondern die Antwort: der Stand der
     Oberfläche kann veraltet sein, weil ein zweites Gerät inzwischen
     umgestellt hat. Maßgeblich ist, was der Server gerade herausgegeben hat. */
  if (antwort.fassung !== schluessel.fassung) throw new Error(txt('fehler.passwortSchluesselGewechselt'));

  const roh = await huelleLesen(schluessel.key, antwort.chiffrat);
  if (!roh) throw new Error(txt('fehler.passwortKeinChiffrat'));
  const passwort = typeof roh.passwort === 'string' ? roh.passwort : '';

  if (!antwort.altbestand) return { passwort, umgestellt: null };

  /* ALTBESTAND: das war die eine alte Hülle mit allem drin. Sie wird jetzt
     in zwei zerlegt und in EINEM Aufruf zurückgeschrieben — der Server
     schreibt beide in einer Transaktion (services/passwoerter.ts,
     speichern()), es gibt also keinen Zwischenstand, in dem das Passwort
     entweder verloren oder doppelt vorhanden wäre.

     Kein `force`: hat ein zweites Gerät zwischenzeitlich umgestellt oder
     gespeichert, soll dieser Lauf scheitern statt dessen Stand zu
     überschreiben. Beim nächsten Laden ist der Eintrag ohnehin umgestellt. */
  /* Dieselbe Hülle liefert BEIDES: `schaufensterAus()` nimmt die Felder der
     Liste heraus und lässt `passwort` liegen, der Wert daneben geht in die
     zweite Hülle. */
  const schaufenster = schaufensterAus(roh);
  const ergebnis = await passwortSpeichern(eintrag.id, schaufenster, eintrag.version, false, passwort);
  if (!ergebnis.ok) throw new Error(txt('fehler.passwortSchluesselGewechselt'));
  return { passwort, umgestellt: { eintrag: ergebnis.eintrag, schaufenster } };
}

/**
 * Das Passwort eines Eintrags holen — für Aufdecken UND für Kopieren.
 *
 * Jeder Aufruf ist eine Aushändigung und steht danach im Verlauf. Kopieren
 * ruft das auch dann, wenn gerade aufgedeckt ist: es ist ein zweiter Weg an
 * den Wert (in die Zwischenablage, womöglich über Geräte hinweg), und ihn
 * nur deshalb nicht zu vermerken, weil der Wert schon auf dem Schirm steht,
 * hieße das Protokoll wieder von der Anzeige abhängig zu machen — genau der
 * Fehler, den die Trennung beseitigt hat.
 */
export async function passwortGeheimnisHolen(eintrag: Passworteintrag): Promise<{
  passwort: string;
  umgestellt: { eintrag: Passworteintrag; schaufenster: PasswortSchaufenster } | null;
}> {
  return geheimnisAbrufen(eintrag);
}

/**
 * Einen Eintrag aus dem Altbestand umstellen, ohne sein Passwort zu behalten.
 *
 * Das braucht die Tafel beim Auswählen: ein Altbestandseintrag hat noch kein
 * Schaufenster, seine Zeile in der Liste bleibt ohne Etikett, bis er
 * umgestellt ist. Das Passwort kommt dabei zwangsläufig über die Leitung —
 * es steckt ja in derselben alten Hülle — und die Aushändigung wird deshalb
 * vermerkt wie jede andere. Sie geschieht EINMAL je Eintrag; danach liefert
 * die Liste das Schaufenster und niemand holt mehr etwas, ohne es zu wollen.
 *
 * Das Passwort wird hier ausdrücklich VERWORFEN und nicht zurückgegeben: wer
 * einen Eintrag anklickt, hat nicht auf "aufdecken" gedrückt.
 *
 * `null` heißt: der Eintrag war schon umgestellt, ein zweites Gerät war
 * schneller. Kein Fehler — die Tafel lädt dann neu und findet ein
 * Schaufenster vor. Ein leeres Schaufenster zurückzugeben wäre hier der
 * gefährliche Ausweg: die Tafel zeigte ein leeres Formular, das nächste
 * automatische Speichern schriebe es fest, und ein Eintrag wäre still leer.
 */
export async function passwortUmstellen(
  eintrag: Passworteintrag,
): Promise<{ eintrag: Passworteintrag; schaufenster: PasswortSchaufenster } | null> {
  const { umgestellt } = await geheimnisAbrufen(eintrag);
  return umgestellt;
}

/* ── Kopieren, mit Selbstlöschung ──────────────────────────────────
 *
 * 20 Sekunden: genug für einen einzigen bewussten Einfüge-Vorgang (Wechsel
 * zum Anmeldefenster, Einfügen, Absenden), knapp genug, dass ein Passwort
 * nicht den Rest eines Arbeitstags lang in der Zwischenablage eines Rechners
 * steht, der auf einem geteilten Bildschirm läuft. Ein Klick auf "Kopieren"
 * dieses Eintrags oder einer beliebigen anderen Anwendung setzt die Uhr
 * ohnehin neu — diese Funktion löscht nur, was SIE selbst hineingelegt hat,
 * und nur dann, wenn zwischenzeitlich nichts anderes hineinkam: sonst risse
 * ein Kopiervorgang aus dem Tresor eine ganz andere, danach kopierte
 * Zeichenkette wieder heraus.
 *
 * WARUM DAS NICHT ÜBER `navigator.clipboard` LÄUFT
 *
 * Hier stand genau das, und es konnte nie funktionieren. Der Vergleich
 * braucht ein `readText()`, und dem stehen in dieser Ansicht drei
 * unabhängige Hürden im Weg, von denen jede einzelne genügt:
 *
 *   · In der App fragt Chromium die Berechtigung `clipboard-read` an, und
 *     electron/main.ts beantwortet alles außer Ton mit Nein.
 *   · Chromium verweigert das Lesen, solange das Dokument nicht den Fokus
 *     hat — und der ganze Zweck des Kopierens ist, dass die Person inzwischen
 *     in einem anderen Fenster einfügt.
 *   · Der Aufruf steckt in einem Timer, hat also keine frische Nutzerhandlung
 *     im Rücken.
 *
 * Der Fehlschlag lief außerdem in ein leeres `catch`: Kopieren klappte,
 * Aufräumen nie, und niemand erfuhr davon. Das Passwort blieb in der Ablage
 * liegen — auf einem Mac über die geräteübergreifende Zwischenablage bis auf
 * das Telefon, für jedes Verlaufsprogramm lesbar und für die eigene
 * Fernsteuerungsbrücke, die die Ablage zweimal je Sekunde abfragt
 * (electron/fernsteuerung.ts).
 *
 * Deshalb geht beides — Schreiben UND das prüfende Zurücklesen — über den
 * Hauptprozess (`window.stellium.ablage`, siehe electron/preload.ts). Der
 * kennt weder Berechtigungsfrage noch Fokus noch Nutzerhandlung.
 *
 * IM BROWSER GIBT ES DIESEN WEG NICHT, und dort ist er auch nicht
 * nachzubauen: Safari verlangt für `readText()` eine Geste, Firefox gibt es
 * Webseiten überhaupt nicht. Der Server liefert dieselbe Ansicht aus, und
 * der Tresor hängt nicht an Electron — diese Lage ist also echt und kein
 * Randfall. Die Entscheidung dafür: KOPIEREN BLEIBT ERLAUBT, aber die
 * Selbstlöschung wird nicht behauptet. `kopierenUndLoeschen()` gibt zurück,
 * ob sie überhaupt möglich ist, und die Tafel sagt es der Person vorher am
 * Feld und nachher in der Meldung. Das Kopieren dort zu VERBIETEN wäre die
 * schlechtere Wahl: dann tippt jemand das Passwort ab oder holt es sich
 * anders — nur eben ohne jeden Hinweis.
 *
 * Bewacht von scripts/passwort-ablage-pruefen.mjs: der Lauf lädt DIESE Datei
 * und lässt sie gegen eine Ablage arbeiten, deren readText() immer ablehnt —
 * genau wie das echte Chromium. Er sagt am Ende auch ausdrücklich, was er
 * ohne Browser nicht prüfen kann.
 */
const KOPIEREN_LOESCHEN_NACH_MS = 20_000;

/** Ob diese Ansicht die Zwischenablage überhaupt selbst wieder leeren kann.
 *  Falsch im Browser und in älteren App-Fassungen ohne die Brücke. */
export function ablageLoeschbar(): boolean {
  return typeof window !== 'undefined' && Boolean(window.stellium?.ablage);
}

/**
 * Wert kopieren und — wenn möglich — nach `ms` wieder herausnehmen.
 *
 * Gibt `true` zurück, wenn die Selbstlöschung eingeplant ist, `false`, wenn
 * diese Ansicht sie nicht leisten kann. Der Rückgabewert ist keine
 * Höflichkeit: die Tafel sagt der Person damit SOFORT, ob das Passwort von
 * selbst wieder verschwindet.
 *
 * `aufNichtGeleert` läuft, wenn das Aufräumen später doch scheitert (Brücke
 * antwortet nicht, Ablage vom System gesperrt). Still darf das nirgends
 * bleiben — der stille Fehlschlag war der eigentliche Defekt.
 *
 * Wirft weiter, wenn schon das SCHREIBEN scheitert: dann ist gar nichts
 * kopiert worden, und "kopiert!" wäre eine Lüge. Der Aufrufer fängt es.
 */
export async function kopierenUndLoeschen(
  wert: string,
  aufNichtGeleert?: () => void,
  ms = KOPIEREN_LOESCHEN_NACH_MS,
): Promise<boolean> {
  const bruecke = typeof window !== 'undefined' ? window.stellium?.ablage : undefined;

  if (!bruecke) {
    await navigator.clipboard.writeText(wert);
    return false;
  }

  if (!await bruecke.schreiben(wert)) throw new Error(txt('fehler.ablageSchreiben'));

  setTimeout(() => {
    void (async () => {
      let weg = false;
      try {
        weg = await bruecke.leerenWennUnveraendert(wert);
      } catch {
        weg = false;
      }
      if (!weg) aufNichtGeleert?.();
    })();
  }, ms);
  return true;
}
