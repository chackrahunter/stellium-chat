import {
  ANMELDE_KDF, ANMELDE_NACHWEIS_KONTEXT, ANMELDE_RUNDEN,
  type AnmeldeSalz, type SelfUser,
} from '@stellium/shared';
import { api } from '../net/api.js';
import { b64u, unb64u } from './vertraulich.js';

/**
 * Der Anmeldenachweis — das Passwort bleibt auf dem Gerät.
 *
 * DIE LÜCKE, DIE DIESE DATEI SCHLIESST
 *
 * Im Kopf von lib/kontoschluessel.ts steht sie ausgeschrieben: der
 * Kontoschlüssel wird aus dem PASSWORT abgeleitet, und das Passwort ging
 * bisher bei jeder Anmeldung im Klartext zum Server. Ein Server, der in
 * genau diesem Augenblick mitschriebe, konnte denselben Kontoschlüssel
 * herleiten wie jedes Gerät — und damit jede Notiz öffnen, die er schützt.
 * Dort steht auch, wer das beheben muss: „Wer diese Lücke schließen will,
 * muss die ANMELDUNG ändern (das Passwort gar nicht erst senden, sondern
 * nur einen daraus abgeleiteten Nachweis)". Das ist diese Datei.
 *
 * WAS STATT DES PASSWORTS HINAUSGEHT
 *
 * PBKDF2 über das Passwort mit einem kontoeigenen Salz, danach HKDF mit
 * einer ausgeschriebenen Zweckangabe — dieselbe Machart wie
 * passwortSchluessel() in lib/kontoschluessel.ts, aber mit anderem Salz und
 * anderer Zweckangabe. Aus dem Nachweis lässt sich der Kontoschlüssel-KEK
 * NICHT herleiten: dafür bräuchte man das Passwort, und PBKDF2 rechnet
 * nicht rückwärts. Genau das ist der Gewinn.
 *
 * WAS DAS EHRLICHERWEISE NICHT LEISTET
 *
 * Erstens ist der Nachweis passwortgleich in dem Sinn, dass er ALLEIN zum
 * Anmelden genügt: wer ihn von der Leitung abfängt, kommt herein. Der
 * Unterschied ist, was er NICHT öffnet — die Notizen.
 *
 * Zweitens schützt das gegen einen Server, der MITSCHREIBT, nicht gegen
 * einen, der LÜGT. Ein böswillig umgebauter Server könnte behaupten, dieses
 * Konto habe keinen Nachweis, und die App fiele auf den alten Weg zurück —
 * mit dem Passwort im Gepäck. Dass sie das tut, ist Absicht und nicht
 * Nachlässigkeit: die Alternative wäre eine App, die sich weigert, sich
 * anzumelden, und der Server steht auf einem Rechner, an den niemand
 * herankommt. Eine Weigerung wäre dort nicht zurückzunehmen. Der Merker
 * unten macht den Rückfall wenigstens selten: ein Gerät, das den neuen Weg
 * für ein Konto einmal gegangen ist, versucht ihn ab dann zuerst.
 *
 * Drittens bleiben `/api/auth/setup` und `/api/auth/password` weiterhin
 * Wege, auf denen ein Passwort im Klartext zum Server geht. Das lässt sich
 * jetzt nicht ändern: solange der alte Anmeldeweg trägt, MUSS der Server
 * `users.password_hash` aus dem Passwort selbst führen, und dafür muss er
 * es beim Setzen einmal sehen. Beides fällt zusammen weg, wenn der alte Weg
 * eines Tages stillgelegt wird — vorher nicht.
 */

/* ── Der Merker auf dem Gerät ─────────────────────────────────── */

/**
 * Welche Anmeldenamen dieses Gerät schon einmal über den neuen Weg
 * hereingebracht hat.
 *
 * Reine Abkürzung, kein Wächter. Ohne ihn müsste jede Anmeldung den neuen
 * Weg blind versuchen, bei einem Konto ohne Nachweis ein 401 kassieren und
 * damit einen Versuch der Bremse verbrauchen — vier Tippfehler statt acht,
 * bevor die Minute Wartezeit kommt. Mit ihm zahlt das nur die allererste
 * Anmeldung auf einem Gerät.
 *
 * Er SPERRT ausdrücklich nichts. Steht er und der Server hat trotzdem
 * keinen Nachweis (nach einem Zurücksetzen durch die Verwaltung etwa),
 * fällt die Anmeldung still auf den alten Weg zurück und hinterlegt danach
 * einen neuen. Ein Merker, der eine Anmeldung verhindern kann, wäre auf
 * einem unerreichbaren Server eine Aussperrung mit Ansage.
 *
 * Je NAME und nicht je Konto: vor der Anmeldung gibt es keine Kontokennung,
 * nur das, was jemand eingetippt hat — und dieselbe Person kann sich mit
 * Benutzernamen ODER E-Mail anmelden. Beide bekommen ihren eigenen Eintrag,
 * beide funktionieren, weil das Salz am Konto hängt und nicht am Namen.
 */
const SCHL_MERKER = 'stellium.anmeldung.nachweis';
const MERKER_HOECHSTENS = 20;

function schluesselFuer(login: string): string {
  return login.trim().toLowerCase();
}

function merkerLesen(): string[] {
  try {
    const roh = localStorage.getItem(SCHL_MERKER);
    const liste = roh ? (JSON.parse(roh) as unknown) : null;
    return Array.isArray(liste) ? liste.filter((e): e is string => typeof e === 'string') : [];
  } catch { return []; }
}

/** Kennt dieses Gerät den neuen Weg für diesen Namen? */
export function nachweisBekannt(login: string): boolean {
  return merkerLesen().includes(schluesselFuer(login));
}

function merken(login: string): void {
  try {
    const name = schluesselFuer(login);
    const liste = merkerLesen().filter((e) => e !== name);
    liste.push(name);
    // Nach vorne abschneiden: der älteste Name fliegt zuerst. Auf einem
    // Gerät, das zwanzig verschiedene Konten gesehen hat, kostet ein
    // vergessener Eintrag nur einen einzigen Anmeldeversuch mehr.
    localStorage.setItem(SCHL_MERKER, JSON.stringify(liste.slice(-MERKER_HOECHSTENS)));
  } catch { /* voll oder gesperrt */ }
}

/** Beim Abmelden bleibt der Merker ABSICHTLICH stehen. Er ist kein
 *  Geheimnis (er sagt nur „dieser Name kann den neuen Weg"), und ihn
 *  wegzuwerfen hieße, bei der nächsten Anmeldung wieder mit dem Passwort im
 *  Klartext anzufangen. */

/* ── Die Ableitung ────────────────────────────────────────────── */

const enc = new TextEncoder();

async function sha256(text: string): Promise<Uint8Array<ArrayBuffer>> {
  return new Uint8Array(await crypto.subtle.digest('SHA-256', enc.encode(text)));
}

/**
 * Aus dem Passwort den Nachweis.
 *
 * PBKDF2 zuerst (die teure Runde), danach HKDF mit einer ausgeschriebenen
 * Zweckangabe. Der zweite Schritt kostet nichts und trennt diese Ableitung
 * von jeder anderen aus demselben Passwort — allen voran der des
 * Kontoschlüssels in lib/kontoschluessel.ts. Selbst wenn dort und hier
 * einmal dasselbe Salz stünde, käme nie derselbe Wert heraus.
 *
 * KEINE Bindung an die Kontokennung, anders als beim Kontoschlüssel: vor
 * der Anmeldung kennt das Gerät seine Kennung noch gar nicht. Was den
 * Nachweis an genau ein Konto bindet, ist das Salz.
 */
export async function nachweisBilden(
  passwort: string, salz: Uint8Array<ArrayBuffer>, runden: number,
): Promise<string> {
  const roh = await crypto.subtle.importKey('raw', enc.encode(passwort), 'PBKDF2', false, ['deriveBits']);
  const bits = await crypto.subtle.deriveBits(
    { name: 'PBKDF2', salt: salz, iterations: runden, hash: 'SHA-256' }, roh, 256,
  );
  const zwischen = await crypto.subtle.importKey('raw', bits, 'HKDF', false, ['deriveBits']);
  const fertig = await crypto.subtle.deriveBits(
    {
      name: 'HKDF', hash: 'SHA-256',
      salt: await sha256(ANMELDE_NACHWEIS_KONTEXT),
      info: enc.encode(ANMELDE_NACHWEIS_KONTEXT),
    },
    zwischen, 256,
  );
  return b64u(new Uint8Array(fertig));
}

/* ── Anmelden ─────────────────────────────────────────────────── */

export interface Anmeldung {
  token: string;
  user: SelfUser;
  /** Ging es ohne Passwort über die Leitung? Steuert, ob danach ein
   *  Nachweis nachgetragen wird — siehe nachweisNachtragen(). */
  ueberNachweis: boolean;
}

/**
 * Welche Fehler vom neuen Weg NICHT auf den alten führen dürfen.
 *
 * 403 heißt „Konto gesperrt" — der alte Weg gäbe dieselbe Antwort und hätte
 * dafür das Passwort hinausgeschickt. 429 heißt „Bremse" — ein zweiter
 * Versuch fütterte sie nur weiter. 0 heißt „Server nicht erreichbar" — dann
 * ist auch der alte Weg nicht erreichbar, und ein zweiter Anlauf kostete
 * nur ein weiteres Zeitlimit.
 *
 * ALLES ANDERE führt zurück auf den alten Weg, ausdrücklich auch ein 404
 * und ein 400: so antwortet ein Server, der diese Wege noch gar nicht kennt.
 * Eine neue App muss sich an einem alten Server anmelden können.
 */
function durchreichen(status: number | undefined): boolean {
  return status === 403 || status === 429 || status === 0;
}

/**
 * Anmelden — neuer Weg zuerst, alter Weg als Auffangnetz.
 *
 * Die Reihenfolge ist der ganze Entwurf. Der alte Weg bleibt unangetastet
 * erreichbar, damit niemand aussperrbar ist; der neue wird bevorzugt, damit
 * das Passwort in aller Regel nicht mehr hinausgeht.
 */
export async function anmelden(login: string, passwort: string): Promise<Anmeldung> {
  if (nachweisBekannt(login)) {
    try {
      const beschreibung: AnmeldeSalz = await api.anmeldeSalz(login);
      const nachweis = await nachweisBilden(passwort, unb64u(beschreibung.salz), beschreibung.runden);
      const antwort = await api.loginMitNachweis(login, nachweis);
      return { ...antwort, ueberNachweis: true };
    } catch (err) {
      const status = (err as { status?: number }).status;
      if (durchreichen(status)) throw err;
      /* Still weiter auf dem alten Weg. Kein Hinweis an die Person: für sie
         ist das kein Ereignis, sondern eine Anmeldung wie jede andere. */
    }
  }
  const antwort = await api.login(login, passwort);
  return { ...antwort, ueberNachweis: false };
}

/**
 * Nach einer Anmeldung über den ALTEN Weg einen Nachweis hinterlegen.
 *
 * Das ist die ganze Umstellung: sie geschieht von selbst, bei der ersten
 * Anmeldung mit einer neuen App, ohne dass jemand etwas tun oder auch nur
 * davon wissen müsste.
 *
 * WIRFT NIE. Ein Server, der gerade nicht antwortet, ein Konto, das noch in
 * der Ersteinrichtung steht (dort weist der Riegel in server/src/index.ts
 * diesen Weg mit Absicht ab), ein alter Server, der ihn gar nicht kennt —
 * nichts davon darf eine gelungene Anmeldung nachträglich zu einem Fehler
 * machen. Beim nächsten Mal wird es wieder versucht.
 *
 * Das Salz wählt DIESES Gerät. Ein Server, der es vorgäbe, könnte allen
 * Konten dasselbe zuteilen und sich damit eine vorgerechnete Tabelle bauen.
 */
export async function nachweisNachtragen(login: string, passwort: string): Promise<void> {
  try {
    const salz = crypto.getRandomValues(new Uint8Array(16));
    const nachweis = await nachweisBilden(passwort, salz, ANMELDE_RUNDEN);
    await api.anmeldeNachweisHinterlegen({
      kdf: ANMELDE_KDF, salz: b64u(salz), runden: ANMELDE_RUNDEN, nachweis,
    });
    merken(login);
  } catch (err) {
    console.warn('[anmeldenachweis]', (err as Error).message);
  }
}
