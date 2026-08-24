import {
  CODE_ALPHABET, NOTZUGANG_ABDRUCK_VORSPANN, NOTZUGANG_ANTEILE,
  NOTZUGANG_CODE_RUNDEN, NOTZUGANG_SCHWELLE,
  WIEDERHERSTELLUNG_GRUPPEN, WIEDERHERSTELLUNG_GRUPPENLAENGE,
  notzugangAnteilKontext, notzugangBeitragKontext,
  teilen, wiederherstellungNormalisieren, zusammenfuegen,
  type Anteil, type FluechtigesPaket, type NotzugangAnteilBlob,
  type NotzugangHuelle, type NotzugangStand,
} from '@stellium/shared';
import { api } from '../net/api.js';
import { useStore } from '../state/store.js';
import { mitNotschluesselWiederherstellen, notzugangHuelleErzeugen } from './kontoschluessel.js';
import {
  abdruckVon, b64u, eigenerPrivaterSchluessel, fremderOeffentlicherSchluessel,
  gemeinsamerSchluesselMit, schluesselAnfordern, unb64u,
} from './vertraulich.js';

/**
 * Der Notzugang — „3 von 5".
 *
 * DER WIDERSPRUCH, UM DEN ES GEHT
 *
 * „Die Verwaltung soll jemanden wieder hereinlassen können, der sein Passwort
 * vergessen hat" und „niemand außer der besitzenden Person soll mitlesen
 * können" sind als Sätze unvereinbar: wer wiederherstellen kann, kann lesen.
 * Aufgelöst wird das nicht, indem einer der Sätze fällt, sondern indem
 * NIEMAND ALLEIN beides kann.
 *
 * Ein zufälliger Notschlüssel verschließt den Kontoschlüssel ein zweites Mal
 * (lib/kontoschluessel.ts, notzugangHuelleErzeugen()). Er wird in fünf
 * Anteile zerlegt (shared/geheimnisteilung.ts), jeder Anteil einzeln für eine
 * Kollegin oder einen Kollegen verschlossen. Drei setzen ihn zusammen, zwei
 * ergeben nichts — und zwar nicht „fast nichts", sondern nichts: zu zwei
 * Anteilen ist jeder mögliche Schlüssel gleich wahrscheinlich.
 *
 * WER AM ENDE DEN SCHLÜSSEL IN DER HAND HÄLT
 *
 * Die BESITZENDE PERSON selbst, und niemand sonst. Das ist die wichtigste
 * Entscheidung in dieser Datei, und sie ist strenger als der Auftrag
 * verlangte. Die naheliegende Bauart wäre: eine Verwaltung sammelt drei
 * Anteile ein, stellt den Kontoschlüssel her und reicht ihn weiter — dann
 * hätte diese eine Person ihn einen Augenblick lang, mit allem, was daran
 * hängt. Muss sie aber nicht: wer sein Passwort vergessen hat, kann sich
 * nach einem gewöhnlichen Zurücksetzen wieder ANMELDEN, nur eben nicht mehr
 * an seine Notizen. Also sammelt sie die Anteile selbst ein, und jeder
 * Beitrag ist für IHREN heutigen öffentlichen Teil verschlossen. Die
 * Verwaltung setzt das Passwort zurück und hält höchstens einen der fünf
 * Anteile — sie kommt an keiner Stelle des Weges an den Kontoschlüssel.
 *
 * DIE ZWEI SCHLÖSSER AN JEDEM BEITRAG
 *
 * Ein Beitrag ist mit einer Ableitung aus ZWEI Geheimnissen verschlossen:
 * dem ECDH-Geheimnis zur anfragenden Person UND einem Code, den sie den drei
 * Beitragenden mündlich nennt. Ohne das zweite Schloss wäre die
 * Vertraulichkeit eine Hausregel, an die sich der Server halten müsste: er
 * gibt die öffentlichen Teile aus und könnte einen eigenen unterschieben.
 * Der Code erreicht ihn nie. Dieselbe Überlegung wie bei den Freigaben in
 * lib/vertraulich.ts (vorfallMelden()), nur in einer Ableitung statt in zwei
 * Schichten.
 *
 * WAS DER NOTSCHLÜSSEL NIEMALS WIRD: EINE ZEICHENKETTE
 *
 * Weder er noch ein Anteil verlässt hier je die Form eines Uint8Array.
 * Zeichenketten lassen sich in JavaScript nicht überschreiben — ein einziges
 * `b64u(notschluessel)` legte eine Kopie an, die bis zur nächsten
 * Speicherbereinigung im Prozess steht und die niemand mehr löschen kann.
 * Die verschlossenen Anteile tragen deshalb ein festes Byteformat
 * (anteilBytes() unten) statt JSON, und jedes Rohfeld wird nach Gebrauch in
 * einem `finally` genullt. Abgelegt wird nichts davon, nirgends: kein
 * localStorage, keine Datei, kein Server.
 *
 * WAS DAS EHRLICHERWEISE NICHT LEISTET
 *
 * Beim EINRICHTEN wird jeder Anteil für den öffentlichen Teil verschlossen,
 * den der Server für diese Person ausgibt. Ein Server, der dort einen
 * eigenen unterschiebt, kann den Anteil mitlesen; bei dreien hätte er den
 * Notschlüssel. Das ist keine Lücke dieses Notzugangs, sondern die bekannte
 * Grenze der Ende-zu-Ende-Verschlüsselung im ganzen Haus (siehe abdruckVon()
 * in lib/vertraulich.ts: „die einzige Möglichkeit festzustellen, dass der
 * Server keinen eigenen Schlüssel untergeschoben hat"). Zwei Dinge dämmen
 * sie ein: der Abdruck, für den verpackt wurde, wird MITGESPEICHERT — ein
 * untergeschobener oder gewechselter Schlüssel fällt spätestens beim
 * Einlösen auf, statt still zu wirken. Und beim WIEDERHERSTELLEN, dem
 * Augenblick, in dem der Notschlüssel wirklich entsteht, hilft dem Server
 * ein untergeschobener Teil nichts mehr: dort steht der Code daneben.
 */

/* ── Kleinkram ────────────────────────────────────────────────── */

const enc = new TextEncoder();

async function sha256(daten: Uint8Array<ArrayBuffer> | string): Promise<Uint8Array<ArrayBuffer>> {
  const bytes = typeof daten === 'string'
    ? (enc.encode(daten) as Uint8Array<ArrayBuffer>) : daten;
  return new Uint8Array(await crypto.subtle.digest('SHA-256', bytes));
}

/** Der Abdruck des Notschlüssels — roh, nie als Zeichenkette. */
async function notAbdruck(notschluessel: Uint8Array<ArrayBuffer>): Promise<Uint8Array<ArrayBuffer>> {
  const vorspann = enc.encode(NOTZUGANG_ABDRUCK_VORSPANN);
  const zusammen = new Uint8Array(vorspann.length + notschluessel.length);
  zusammen.set(vorspann, 0);
  zusammen.set(notschluessel, vorspann.length);
  try {
    return await sha256(zusammen);
  } finally {
    zusammen.fill(0);
  }
}

function gleich(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  let unterschied = 0;
  for (let i = 0; i < a.length; i++) unterschied |= a[i]! ^ b[i]!;
  return unterschied === 0;
}

/** Zufällige Zeichen aus dem verwechslungsfreien Vorrat — wortgleich zu
 *  zufallsCode() in lib/vertraulich.ts, dort mit ausführlicher Begründung
 *  für das Modulo. */
function zufallsCode(zeichen: number): string {
  const roh = new Uint32Array(zeichen);
  crypto.getRandomValues(roh);
  return [...roh].map((z) => CODE_ALPHABET[z % CODE_ALPHABET.length]).join('');
}

/* ── Das Byteformat eines Anteils ─────────────────────────────── */

/**
 * Ein Anteil, wie er verschlossen wird: 4 Kopfbytes, dann die Werte, dann
 * der Abdruck des Notschlüssels.
 *
 *   [0] Formatkennung — damit ein späteres Format nicht stillschweigend
 *       falsch gelesen wird, sondern auffällt.
 *   [1] Schwelle, [2] Anzahl — sie stehen IM verschlossenen Teil und nicht
 *       daneben. Stünden sie außen, könnte jemand die Schwelle von drei auf
 *       zwei setzen und behaupten, das sei so vereinbart gewesen. Beim
 *       Zusammensetzen wird verlangt, dass alle Anteile dieselbe Zahl
 *       tragen — eine gesenkte Schwelle fällt damit auf.
 *   [3] Die Stelle im Körper (1…5).
 *   [4…] Die Werte, dann die 32 Bytes Abdruck.
 */
const ANTEIL_FORMAT = 1;
const ANTEIL_KOPF = 4;
const ABDRUCK_BYTES = 32;

function anteilBytes(
  anteil: Anteil, abdruck: Uint8Array<ArrayBuffer>, schwelle: number, anzahl: number,
): Uint8Array<ArrayBuffer> {
  const raus = new Uint8Array(ANTEIL_KOPF + anteil.werte.length + ABDRUCK_BYTES);
  raus[0] = ANTEIL_FORMAT;
  raus[1] = schwelle;
  raus[2] = anzahl;
  raus[3] = anteil.stelle;
  raus.set(anteil.werte, ANTEIL_KOPF);
  raus.set(abdruck, ANTEIL_KOPF + anteil.werte.length);
  return raus;
}

interface GelesenerAnteil {
  anteil: Anteil;
  abdruck: Uint8Array<ArrayBuffer>;
  schwelle: number;
  anzahl: number;
}

function anteilLesen(bytes: Uint8Array<ArrayBuffer>): GelesenerAnteil | null {
  if (bytes.length <= ANTEIL_KOPF + ABDRUCK_BYTES) return null;
  if (bytes[0] !== ANTEIL_FORMAT) return null;
  const werte = bytes.slice(ANTEIL_KOPF, bytes.length - ABDRUCK_BYTES);
  return {
    anteil: { stelle: bytes[3]!, werte },
    abdruck: bytes.slice(bytes.length - ABDRUCK_BYTES),
    schwelle: bytes[1]!,
    anzahl: bytes[2]!,
  };
}

/* ── Verpacken und Öffnen ─────────────────────────────────────── */

/** Aus dem Code die zusätzlichen Bytes für die Ableitung — teuer gerechnet,
 *  weil ein Code kurz ist gegenüber einem Schlüssel. */
async function codeBytes(code: string, kontext: string): Promise<Uint8Array<ArrayBuffer>> {
  const roh = await crypto.subtle.importKey('raw', enc.encode(code), 'PBKDF2', false, ['deriveBits']);
  return new Uint8Array(await crypto.subtle.deriveBits(
    {
      name: 'PBKDF2', salt: await sha256(kontext),
      iterations: NOTZUGANG_CODE_RUNDEN, hash: 'SHA-256',
    },
    roh, 256,
  ));
}

/**
 * Etwas für einen fremden öffentlichen Teil verschließen — mit einem
 * WEGWERF-Schlüsselpaar als Absender.
 *
 * Der private Teil des Paares lebt genau so lange wie dieser Aufruf. Er wird
 * nirgends abgelegt, und niemand kann daraus später etwas herleiten: was
 * bleibt, ist der öffentliche Teil im Paket, und der allein rechnet nichts.
 */
async function verschliessen(
  fremdJwk: string, kontext: string, klartext: Uint8Array<ArrayBuffer>,
  zusatz?: Uint8Array<ArrayBuffer>,
): Promise<FluechtigesPaket> {
  const paar = await crypto.subtle.generateKey(
    { name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits'],
  ) as CryptoKeyPair;
  const eph = JSON.stringify(await crypto.subtle.exportKey('jwk', paar.publicKey));
  const key = await gemeinsamerSchluesselMit(
    paar.privateKey, fremdJwk, kontext, 'stellium/notzugang/paket/v1', zusatz,
  );
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const daten = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, klartext);
  return { alg: 'aes-gcm', eph, iv: b64u(iv), daten: b64u(new Uint8Array(daten)) };
}

/**
 * Und wieder auf — mit dem eigenen, dauerhaften privaten Teil.
 *
 * Ausdrücklich DIESELBE Ableitung wie beim Verschließen, bis auf die
 * vertauschten Hälften des ECDH: derselbe Kontext, dieselbe Zweckangabe,
 * derselbe (oder kein) Zusatz. Eine abweichende Zweckangabe wäre der
 * unauffälligste denkbare Fehler — sie ergäbe einen anderen Schlüssel, und
 * AES-GCM meldete nur „geht nicht auf", ohne zu sagen, warum.
 */
async function oeffnen(
  paket: FluechtigesPaket, kontext: string, zusatz?: Uint8Array<ArrayBuffer>,
): Promise<Uint8Array<ArrayBuffer> | null> {
  const privat = eigenerPrivaterSchluessel();
  if (!privat) return null;
  try {
    const key = await gemeinsamerSchluesselMit(
      privat, paket.eph, kontext, 'stellium/notzugang/paket/v1', zusatz,
    );
    return new Uint8Array(await crypto.subtle.decrypt(
      { name: 'AES-GCM', iv: unb64u(paket.iv) }, key, unb64u(paket.daten),
    ));
  } catch {
    return null;
  }
}

/* ── Einrichten ───────────────────────────────────────────────── */

/**
 * Einen Notzugang anlegen oder erneuern.
 *
 * Der Notschlüssel entsteht hier, wird hier benutzt und stirbt hier — er
 * verlässt diese Funktion in keiner Form. Was den Rechner verlässt, sind
 * fünf einzeln verschlossene Anteile und eine Hülle um den Kontoschlüssel.
 *
 * Gerufen auch nach jeder gelungenen Wiederherstellung: die verbrauchten
 * Anteile sind durch drei Hände gegangen, also bekommen alle fünf neue.
 */
export async function einrichten(userId: string, halterIds: string[]): Promise<void> {
  if (halterIds.length !== NOTZUGANG_ANTEILE) throw new Error('anzahl');
  await schluesselAnfordern(halterIds);

  const notschluessel = crypto.getRandomValues(new Uint8Array(32));
  let anteile: Anteil[] = [];
  try {
    const abdruck = await notAbdruck(notschluessel);
    const huelle = await notzugangHuelleErzeugen(userId, notschluessel);
    if (!huelle) throw new Error('kein Kontoschlüssel');

    anteile = teilen(notschluessel, NOTZUGANG_SCHWELLE, NOTZUGANG_ANTEILE);
    /* Ab hier wird der Notschlüssel nicht mehr gebraucht — die Hülle steht,
       die Anteile stehen. Er stirbt sofort und nicht erst am Ende: alles
       Weitere ist Netzarbeit, und die kann dauern. */
    notschluessel.fill(0);

    const bloecke: NotzugangAnteilBlob[] = [];
    for (const [i, halterId] of halterIds.entries()) {
      const jwk = fremderOeffentlicherSchluessel(halterId);
      if (!jwk) throw new Error('kein Schlüssel');
      const klartext = anteilBytes(anteile[i]!, abdruck, NOTZUGANG_SCHWELLE, NOTZUGANG_ANTEILE);
      try {
        bloecke.push({
          halterId,
          stelle: anteile[i]!.stelle,
          halterAbdruck: await abdruckVon(jwk),
          paket: await verschliessen(jwk, notzugangAnteilKontext(userId, halterId), klartext),
        });
      } finally {
        klartext.fill(0);
      }
    }
    await api.notzugangEinrichten(huelle, bloecke);
  } finally {
    notschluessel.fill(0);
    for (const a of anteile) a.werte.fill(0);
  }
}

/** Den Notzugang aufheben — die Rettungsleine kappen. Öffnet nichts.
 *  `verbrannt` sagt, ob dabei auch der Kontoschlüssel niedergebrannt ist
 *  (siehe api.notzugangAufheben). */
export function aufheben(): Promise<{ ok: boolean; verbrannt: boolean }> {
  return api.notzugangAufheben();
}

/* ── Wiederherstellen ─────────────────────────────────────────── */

/**
 * Eine Wiederherstellung anstoßen und den Code zurückgeben.
 *
 * Der Code wird genau einmal angezeigt und nirgends gespeichert — auch hier
 * nicht. Zum Server geht nur sein Abdruck; ohne ihn kann er die Beiträge
 * selbst dann nicht öffnen, wenn er den öffentlichen Teil der anfragenden
 * Person durch einen eigenen ersetzt hätte.
 */
export async function anfragen(): Promise<{ anfrageId: string; code: string }> {
  const roh = zufallsCode(WIEDERHERSTELLUNG_GRUPPEN * WIEDERHERSTELLUNG_GRUPPENLAENGE);
  const code = wiederherstellungNormalisieren(roh);
  const abdruck = await sha256(code.replace(/-/g, ''));
  const { anfrage } = await api.notzugangAnfragen(b64u(abdruck));
  return { anfrageId: anfrage.id, code };
}

/**
 * Als haltende Person einen Anteil beisteuern.
 *
 * Der eigene Anteil wird geöffnet und sofort für die anfragende Person neu
 * verschlossen — mit ihrem HEUTIGEN öffentlichen Teil und dem Code. Der
 * Anteil selbst bleibt dabei ein Uint8Array und wird danach genullt; er
 * steht zu keinem Zeitpunkt als Zeichenkette im Speicher.
 *
 * `false` heißt: der eigene Anteil ging nicht auf. Das ist kein Grund zum
 * Weiterprobieren, sondern eine Auskunft — dieses Gerät hat ein anderes
 * Schlüsselpaar als das, für das der Anteil verpackt wurde.
 */
export async function beitragen(anfrageId: string, codeRoh: string): Promise<boolean> {
  const code = wiederherstellungNormalisieren(codeRoh).replace(/-/g, '');
  const meineId = eigeneKennung();
  const { aufgaben } = await api.notzugangAufgaben();
  const meine = aufgaben.find((a) => a.anfrageId === anfrageId);
  if (!meine) return false;

  const klartext = await oeffnen(meine.anteil, notzugangAnteilKontext(meine.userId, meineId));
  if (!klartext) return false;

  /* Das `try` beginnt DIREKT hinter dem Öffnen und nicht erst hinter
     codeBytes(). Es lag eine Zeile tiefer, und dazwischen stand ein Aufruf,
     der werfen kann (PBKDF2 über den eingetippten Code): flog er, blieb der
     rohe Anteil ungenullt im Speicher stehen — genau die Bytes, um die es in
     dieser ganzen Datei geht. Ein `finally`, das den halben Weg nicht
     abdeckt, ist keines. */
  try {
    const kontext = notzugangBeitragKontext(anfrageId, meineId, meine.userId);
    const zusatz = await codeBytes(code, kontext);
    try {
      await schluesselAnfordern([meine.userId]);
      const jwk = fremderOeffentlicherSchluessel(meine.userId);
      if (!jwk) return false;
      const paket = await verschliessen(jwk, kontext, klartext, zusatz);
      await api.notzugangBeitragen(anfrageId, paket, b64u(await sha256(code)));
      return true;
    } finally {
      zusatz.fill(0);
    }
  } finally {
    klartext.fill(0);
  }
}

export type Ergebnis =
  | { ok: true; beteiligte: string[] }
  | { ok: false; grund: 'zuWenig' | 'verfaelscht' | 'passwort' | 'fehler' };

/**
 * Drei Anteile einsammeln, den Notschlüssel zusammensetzen, den
 * Kontoschlüssel zurückholen — und alles wieder wegwerfen.
 *
 * Die Reihenfolge der Prüfungen ist die eigentliche Arbeit:
 *
 *   1. Jeder Beitrag muss aufgehen. Was nicht aufgeht, zählt nicht mit —
 *      nicht „zählt halb".
 *   2. Alle müssen DIESELBE Schwelle und DENSELBEN Abdruck tragen. Ein
 *      Anteil aus einer früheren Runde oder mit gesenkter Schwelle fällt
 *      hier auf.
 *   3. Es müssen mindestens `schwelle` verschiedene Stellen sein. Zweimal
 *      derselbe Anteil ist ein Punkt, kein zweiter.
 *   4. Nach dem Zusammensetzen wird der Abdruck NACHGERECHNET. Das ist die
 *      einzige Stelle, an der ein verfälschter Anteil auffliegt — Shamir
 *      selbst kann das nicht, drei falsche Punkte legen genauso eine Kurve
 *      fest wie drei richtige. Stimmt er nicht, bricht alles ab: mit einem
 *      falschen Schlüssel weiterzurechnen hieße, den Kontoschlüssel als
 *      „ersetzt" zu hinterlegen und jedes Notiz- und Tresorpaket
 *      mitzunehmen.
 *
 * Danach werden die Anteile erneuert. Sie sind durch drei Hände gegangen;
 * sie liegen zu lassen hieße, die nächste Wiederherstellung mit denselben
 * Anteilen zu erlauben, die schon einmal unterwegs waren. Das kostet einen
 * einzigen weiteren Aufruf und geschieht deshalb ohne Nachfrage. Scheitert
 * es (kein Netz), bleibt der alte Notzugang stehen — eine Rettungsleine
 * weniger wäre die schlechtere Antwort als eine gebrauchte.
 */
export async function wiederherstellen(
  userId: string, anfrageId: string, codeRoh: string, passwort: string,
): Promise<Ergebnis> {
  const code = wiederherstellungNormalisieren(codeRoh).replace(/-/g, '');
  const { huelle } = await api.notzugang();
  if (!huelle) return { ok: false, grund: 'fehler' };

  const { beitraege } = await api.notzugangBeitraege(anfrageId);
  const gelesen: GelesenerAnteil[] = [];
  const meineId = eigeneKennung();

  try {
    for (const b of beitraege) {
      const zusatz = await codeBytes(
        code, notzugangBeitragKontext(anfrageId, b.halterId, meineId),
      );
      let klartext: Uint8Array<ArrayBuffer> | null;
      try {
        klartext = await oeffnen(
          b.paket, notzugangBeitragKontext(anfrageId, b.halterId, meineId), zusatz,
        );
      } finally {
        zusatz.fill(0);
      }
      if (!klartext) continue;
      const a = anteilLesen(klartext);
      klartext.fill(0);
      if (a) gelesen.push(a);
    }

    const schwelle = huelle.schwelle;
    if (!gelesen.length) return { ok: false, grund: 'zuWenig' };
    const brauchbar = gelesen.filter(
      (g) => g.schwelle === schwelle && gleich(g.abdruck, gelesen[0]!.abdruck),
    );
    const stellen = new Set(brauchbar.map((g) => g.anteil.stelle));
    if (brauchbar.length < schwelle || stellen.size < schwelle) {
      return { ok: false, grund: 'zuWenig' };
    }

    let notschluessel: Uint8Array<ArrayBuffer> | null = null;
    try {
      notschluessel = zusammenfuegen(brauchbar.map((g) => g.anteil), schwelle) as Uint8Array<ArrayBuffer>;
      const nachgerechnet = await notAbdruck(notschluessel);
      if (!gleich(nachgerechnet, brauchbar[0]!.abdruck)) return { ok: false, grund: 'verfaelscht' };

      const gelungen = await mitNotschluesselWiederherstellen(userId, passwort, huelle, notschluessel);
      if (!gelungen) return { ok: false, grund: 'passwort' };
    } finally {
      notschluessel?.fill(0);
    }

    const { beteiligte } = await api.notzugangEinloesen(anfrageId);
    try {
      const stand = await api.notzugang();
      const halter = stand.stand.halter.map((h) => h.halterId);
      if (halter.length === NOTZUGANG_ANTEILE) await einrichten(userId, halter);
    } catch {
      /* Die Erneuerung ist die Kür. Der Zugang ist zurück; ein Notzugang mit
         gebrauchten Anteilen ist besser als gar keiner. Beim nächsten Öffnen
         der Tafel lässt er sich von Hand erneuern. */
    }
    return { ok: true, beteiligte };
  } catch {
    return { ok: false, grund: 'fehler' };
  } finally {
    for (const g of gelesen) { g.anteil.werte.fill(0); g.abdruck.fill(0); }
  }
}

/** Die eigene Kennung — beim Aufruf gelesen, nicht beim Laden dieser Datei
 *  (dieselbe Machart wie txt() in lib/vertraulich.ts). */
function eigeneKennung(): string {
  return useStore.getState().self?.id ?? '';
}

/** Nur damit die Tafel nicht selbst rechnen muss, was „genug" heißt. */
export function traegtNoch(stand: NotzugangStand): boolean {
  return stand.eingerichtet && stand.brauchbar >= stand.schwelle;
}

export type { NotzugangHuelle, NotzugangStand };
