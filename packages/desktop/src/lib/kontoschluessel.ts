import {
  KONTO_ABDRUCK_VORSPANN, KONTO_KDF, KONTO_PAKET_ALG, KONTO_RUNDEN,
  NOTZUGANG_ANTEILE, NOTZUGANG_SCHWELLE,
  kontoKekKontext, notizKontoKontext, notzugangKekKontext, passwortKontoKontext,
  type KontoPaket, type KontoSchluesselBlob, type NotzugangHuelle,
} from '@stellium/shared';
import { api } from '../net/api.js';
import { b64u, unb64u } from './vertraulich.js';

/**
 * Der Kontoschlüssel — ein Schlüssel, der dem KONTO gehört, nicht dem Gerät.
 *
 * DER FEHLER, DEN DIESE DATEI BEHEBT
 *
 * Eine Notiz wird für ihre besitzende Person selbst verpackt: ECDH zwischen
 * dem eigenen privaten und dem eigenen öffentlichen Teil. Im Paket steht
 * dann `von: <Kontokennung>` — und genau hier steckt eine Verwechslung. Die
 * Rechnung lief mit dem privaten Teil EINES BESTIMMTEN GERÄTS; die Ablage
 * beim Server (`notiz_schluessel_pakete`, eine Zeile je Notiz und KONTO)
 * kennt aber nur Konten. Ein zweites Gerät desselben Kontos schlägt beim
 * Auspacken den öffentlichen Teil "des Kontos" nach, bekommt seinen EIGENEN
 * und kann die Rechnung nie nachbilden. Zwei Geräte eines Kontos sind
 * kryptografisch zwei Fremde — die Ablage tat, als wären sie einer. Das war
 * der gemeldete Fehler: auf dem Mac angelegt, auf dem Handy für immer
 * "wird entschlüsselt…".
 *
 * DIE ANTWORT
 *
 * Ein zufälliger AES-Schlüssel je Konto. Er liegt beim Server nur
 * verschlossen, und zwar mit einem Schlüssel, den jedes Gerät aus dem
 * PASSWORT selbst herleitet. Das Passwort ist das Einzige, was alle Geräte
 * eines Kontos gemeinsam haben, ohne dass eines mit dem anderen sprechen
 * müsste — und der abgeleitete Schlüssel verlässt das Gerät nie.
 *
 * WAS DER SERVER DABEI SIEHT
 *
 * Bytes. Das Salz und die Rundenzahl (die stehen offen da, sie sind
 * Wegbeschreibung, kein Geheimnis) und einen verschlossenen Block. Weder der
 * abgeleitete Schlüssel noch der Kontoschlüssel noch das Passwort werden je
 * hochgeladen, protokolliert oder auf dem Server abgelegt.
 *
 * WAS DAS EHRLICHERWEISE NICHT LEISTET
 *
 * Das Passwort selbst geht bei der Anmeldung zum Server (POST
 * /api/auth/login) — so war die Anmeldung schon immer gebaut. Ein Server,
 * der in diesem Augenblick BÖSWILLIG mitschriebe, könnte denselben
 * Kontoschlüssel herleiten wie jedes Gerät. Gegen eine gestohlene
 * Datenbanksicherung, einen neugierigen Blick in die Tabellen oder ein
 * Backup auf fremder Platte schützt der Kontoschlüssel vollständig; gegen
 * einen Server, der beim Anmelden mitschreibt, nicht. Das ist der Preis
 * dafür, dass "jedes Gerät mit dem Konto kommt an die Notiz" überhaupt
 * möglich ist: irgendetwas, das alle Geräte kennen, muss den Schlüssel
 * tragen, und das ist das Passwort. Wer diese Lücke schließen will, muss die
 * ANMELDUNG ändern (das Passwort gar nicht erst senden, sondern nur einen
 * daraus abgeleiteten Nachweis) — das ist eine eigene Aufgabe und steht
 * ausdrücklich nicht in dieser.
 *
 * WO DER SCHLÜSSEL AUF DEM GERÄT LIEGT
 *
 * Im localStorage, neben dem privaten ECDH-Teil und dem Anmelde-Token —
 * dieselbe Entscheidung, aus demselben Grund wie im Kopf von
 * lib/vertraulich.ts beschrieben: wer an die Platte kommt und das Konto
 * entsperrt hat, hat ohnehin die laufende Sitzung. Er muss dort liegen, weil
 * das Passwort nur im Augenblick der Anmeldung vorliegt, die Sitzung aber
 * dreißig Tage hält.
 */

/* ── Ablage auf dem Gerät ─────────────────────────────────────── */

const SCHL_KONTO = 'stellium.konto.schluessel';

interface Verwahrt { userId: string; fassung: number; roh: string }

function ablegen(wert: Verwahrt | null): void {
  try {
    if (wert) localStorage.setItem(SCHL_KONTO, JSON.stringify(wert));
    else localStorage.removeItem(SCHL_KONTO);
  } catch { /* voll oder gesperrt */ }
}

function verwahrtLesen(): Verwahrt | null {
  try {
    const roh = localStorage.getItem(SCHL_KONTO);
    return roh ? (JSON.parse(roh) as Verwahrt) : null;
  } catch { return null; }
}

/* ── Kleinkram ────────────────────────────────────────────────── */

const enc = new TextEncoder();

async function sha256(text: string): Promise<Uint8Array<ArrayBuffer>> {
  return new Uint8Array(await crypto.subtle.digest('SHA-256', enc.encode(text)));
}

/* ── Der Zustand dieses Geräts ────────────────────────────────── */

let kontoRoh: Uint8Array<ArrayBuffer> | null = null;
let kontoFassungHier = 0;
let kontoUserId: string | null = null;

/** Kann dieses Gerät gerade über den Kontoweg auspacken? */
export function hatKontoSchluessel(): boolean {
  return Boolean(kontoRoh) && kontoFassungHier > 0;
}

/** Die Fassung, unter der der Kontoschlüssel dieses Geräts steht. Der Server
 *  nimmt nur Notizpakete mit genau dieser Zahl an — siehe
 *  services/notizen.ts, kontoPaketSetzen(). */
export function kontoFassung(): number {
  return kontoFassungHier;
}

/**
 * Beim Start das wieder aufnehmen, was von der letzten Anmeldung liegt.
 *
 * Ohne Passwort — das gibt es beim Start nicht. Passt die Kennung nicht zur
 * angemeldeten Person, wird der verwahrte Schlüssel weggeworfen statt
 * benutzt: er gehört dann zu einem anderen Konto, das sich auf demselben
 * Gerät abgemeldet hat.
 */
export function kontoSchluesselAufnehmen(userId: string): boolean {
  const verwahrt = verwahrtLesen();
  if (!verwahrt || verwahrt.userId !== userId) {
    if (verwahrt) ablegen(null);
    kontoRoh = null; kontoFassungHier = 0; kontoUserId = null;
    return false;
  }
  kontoRoh = unb64u(verwahrt.roh);
  kontoFassungHier = verwahrt.fassung;
  kontoUserId = userId;
  return true;
}

/** Beim Abmelden. Der Schlüssel des vorigen Kontos hat auf diesem Gerät
 *  nichts mehr verloren — dieselbe Überlegung wie bei `files` in logout(). */
export function kontoSchluesselVergessen(): void {
  kontoRoh = null; kontoFassungHier = 0; kontoUserId = null;
  ablegen(null);
}

/* ── Die Ableitung aus dem Passwort ───────────────────────────── */

/**
 * Aus dem Passwort den Schlüssel, der die Hülle öffnet.
 *
 * PBKDF2 zuerst (das ist die teure Runde, die einen Angreifer mit gestohlener
 * Datenbank aufhält), danach HKDF mit einem Kontext, in dem die Kennung des
 * Kontos steckt. Der zweite Schritt kostet nichts und leistet zweierlei: er
 * bindet den Schlüssel an genau dieses Konto (eine vertauschte Zeile in der
 * Datenbank ergibt keinen brauchbaren Schlüssel), und er trägt eine
 * ausgeschriebene Zweckangabe — dieselbe Machart wie gemeinsamerSchluessel()
 * in lib/vertraulich.ts.
 *
 * `runden` kommt aus der Zeile und nicht aus der Konstante: eine später
 * erhöhte Rundenzahl darf ältere Hüllen nicht unlesbar machen.
 */
async function passwortSchluessel(
  passwort: string, salz: Uint8Array<ArrayBuffer>, runden: number, userId: string,
): Promise<CryptoKey> {
  const roh = await crypto.subtle.importKey('raw', enc.encode(passwort), 'PBKDF2', false, ['deriveBits']);
  const bits = await crypto.subtle.deriveBits(
    { name: 'PBKDF2', salt: salz, iterations: runden, hash: 'SHA-256' }, roh, 256,
  );
  const zwischen = await crypto.subtle.importKey('raw', bits, 'HKDF', false, ['deriveKey']);
  return crypto.subtle.deriveKey(
    {
      name: 'HKDF', hash: 'SHA-256',
      salt: await sha256(kontoKekKontext(userId)),
      info: enc.encode('stellium/konto/kek/v1'),
    },
    zwischen, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt'],
  );
}

/**
 * Der Abdruck des Kontoschlüssels.
 *
 * SHA-256 über 256 Bit Zufall mit eigenem Vorspann — nicht zurückzurechnen.
 * Er ist die einzige Auskunft, die der Server über den Kontoschlüssel
 * bekommt, und genau die, die er braucht: "ist das noch derselbe?" (siehe
 * services/kontoschluessel.ts, hinterlegen()).
 */
async function abdruckVon(roh: Uint8Array<ArrayBuffer>): Promise<string> {
  const vorspann = enc.encode(KONTO_ABDRUCK_VORSPANN);
  const zusammen = new Uint8Array(vorspann.length + roh.length);
  zusammen.set(vorspann, 0);
  zusammen.set(roh, vorspann.length);
  return b64u(new Uint8Array(await crypto.subtle.digest('SHA-256', zusammen)));
}

/** Einen Kontoschlüssel in eine Hülle legen — für ein bestimmtes Passwort. */
async function umschliessen(
  roh: Uint8Array<ArrayBuffer>, passwort: string, userId: string,
): Promise<KontoSchluesselBlob> {
  const salz = crypto.getRandomValues(new Uint8Array(16));
  const huelle = await passwortSchluessel(passwort, salz, KONTO_RUNDEN, userId);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const daten = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, huelle, roh);
  return {
    kdf: KONTO_KDF, salz: b64u(salz), runden: KONTO_RUNDEN, alg: KONTO_PAKET_ALG,
    iv: b64u(iv), daten: b64u(new Uint8Array(daten)),
    fassung: 0, // vergibt der Server
    abdruck: await abdruckVon(roh),
  };
}

/** Eine Hülle öffnen. `null`, wenn das Passwort nicht passt — AES-GCM sagt
 *  das von selbst, geraten wird hier nichts. */
async function auspacken(
  blob: KontoSchluesselBlob, passwort: string, userId: string,
): Promise<Uint8Array<ArrayBuffer> | null> {
  try {
    const huelle = await passwortSchluessel(passwort, unb64u(blob.salz), blob.runden, userId);
    const roh = new Uint8Array(await crypto.subtle.decrypt(
      { name: 'AES-GCM', iv: unb64u(blob.iv) }, huelle, unb64u(blob.daten),
    ));
    // Doppelt geprüft, obwohl AES-GCM schon abgesichert hat: stimmt der
    // Abdruck nicht, ist die Zeile in sich widersprüchlich, und mit einem
    // Schlüssel, dessen Abdruck der Server anders kennt, dürfte dieses Gerät
    // ohnehin kein Notizpaket schreiben.
    if (await abdruckVon(roh) !== blob.abdruck) return null;
    return roh;
  } catch {
    return null;
  }
}

/* ── Einrichten, sobald das Passwort im Klartext vorliegt ─────── */

/**
 * Den Kontoschlüssel dieses Kontos auf diesem Gerät bereitstellen.
 *
 * Gerufen an den drei Stellen, an denen die App das Passwort im Klartext hat
 * und nur dort: Anmeldung, Ersteinrichtung, Passwortwechsel. Es gibt bewusst
 * keinen vierten Weg — jeder wäre einer, der den Kontoschlüssel ohne
 * Passwort herstellen könnte, und dann wäre er keiner mehr.
 *
 * Drei Ausgänge:
 *
 *   Es liegt eine Hülle beim Server und sie geht auf  ->  übernehmen.
 *   Es liegt keine                                    ->  neuen erzeugen.
 *   Es liegt eine, aber sie geht NICHT auf            ->  neuen erzeugen.
 *
 * Der dritte Fall ist der heikle. Er tritt auf, wenn das Passwort zwar
 * stimmt (die Anmeldung war ja erfolgreich), die Hülle aber zu einem
 * FRÜHEREN Passwort gehört — etwa weil eine ältere App beim Wechsel nichts
 * umgeschlossen hat. Diese Hülle bekommt niemand mehr auf, auch die Person
 * selbst nicht. Einen neuen Kontoschlüssel anzulegen ist dann die einzige
 * ehrliche Antwort; der Server räumt dabei alle Notiz-Kontopakete weg (sie
 * gehörten zum alten Schlüssel), und die Geräte, die die Notizen über den
 * GERÄTEWEG öffnen können, schreiben sie neu. Kein Inhalt geht dabei
 * verloren — der Geräteweg bleibt die ganze Zeit unangetastet.
 *
 * Gibt zurück, ob dieses Gerät danach einen Kontoschlüssel hat.
 */
export async function kontoSchluesselEinrichten(userId: string, passwort: string): Promise<boolean> {
  try {
    const { schluessel, notzugangWartet } = await api.kontoSchluessel();
    if (schluessel) {
      const roh = await auspacken(schluessel, passwort, userId);
      if (roh) {
        kontoRoh = roh; kontoFassungHier = schluessel.fassung; kontoUserId = userId;
        ablegen({ userId, fassung: schluessel.fassung, roh: b64u(roh) });
        return true;
      }
    }
    /* DER VIERTE AUSGANG, seit es den Notzugang gibt (lib/notzugang.ts).
       Die drei oben beschriebenen enden alle mit „dann eben einen neuen".
       Das ist falsch, solange ein Notzugang auf den ALTEN Schlüssel zeigt:
       ein neuer Kontoschlüssel ist für den Server ein ERSATZ, und ein Ersatz
       räumt jedes Notiz- und Tresorpaket weg — genau das, was drei Leute
       gerade zurückholen. Hier wird deshalb nichts gemintet; das Gerät
       arbeitet über den Geräteweg weiter und wartet auf die
       Wiederherstellung. Der Server weist einen Ersatz zusätzlich ab
       (services/kontoschluessel.ts) — diese Zeile ist die Höflichkeit, jene
       Abweisung die Sicherung. */
    if (notzugangWartet) return hatKontoSchluessel();
    const neu = crypto.getRandomValues(new Uint8Array(32));
    const blob = await umschliessen(neu, passwort, userId);
    const { fassung } = await api.kontoSchluesselHinterlegen(blob);
    kontoRoh = neu; kontoFassungHier = fassung; kontoUserId = userId;
    ablegen({ userId, fassung, roh: b64u(neu) });
    return true;
  } catch (err) {
    /* Ein Server, der gerade nicht antwortet, darf keine Anmeldung
       verhindern — und schon gar nicht dazu führen, dass ein halb
       eingerichteter Kontoschlüssel im Speicher stehen bleibt. Der Geräteweg
       trägt die Notizen weiterhin; der Kontoweg holt es bei der nächsten
       Anmeldung nach. */
    console.warn('[kontoschluessel]', (err as Error).message);
    return hatKontoSchluessel();
  }
}

/**
 * Beim Passwortwechsel: dieselbe Schlüsselseele, neue Hülle.
 *
 * Ausdrücklich NICHT ein neuer Kontoschlüssel. Bekäme das Konto beim
 * Passwortwechsel einen neuen, verlöre jedes Gerät, das eine Notiz NUR über
 * den Kontoweg lesen kann (also jedes zweite Gerät), den Zugriff auf alle
 * Notizen — bis irgendwann ein Gerät mit Geräteweg wieder online kommt und
 * die Pakete neu schreibt. Ein Passwortwechsel darf niemandem etwas
 * wegnehmen.
 *
 * Der Kontoschlüssel wird dafür bei Bedarf erst noch aus der ALTEN Hülle
 * geholt: ein Gerät, das ihn nicht im Speicher hat (frisch geöffnetes
 * Fenster, geleerter Speicher), kann den Wechsel trotzdem sauber vollziehen,
 * weil in diesem Augenblick beide Passwörter vorliegen.
 *
 * `null` heißt: es gibt nichts umzuschließen. Der Wechsel läuft dann ohne
 * mit — siehe changeOwnPassword() in services/users.ts.
 */
export async function kontoSchluesselUmschliessen(
  userId: string, altesPasswort: string, neuesPasswort: string,
): Promise<KontoSchluesselBlob | null> {
  let roh = kontoUserId === userId ? kontoRoh : null;
  if (!roh) {
    const { schluessel } = await api.kontoSchluessel();
    if (!schluessel) return null;
    roh = await auspacken(schluessel, altesPasswort, userId);
    if (!roh) return null; // gehört zu einem früheren Passwort — siehe Einrichten()
  }
  return umschliessen(roh, neuesPasswort, userId);
}

/**
 * Passwort wechseln — mit dem Kontoschlüssel im Gepäck.
 *
 * Der einzige Weg, den eine künftige Oberfläche nehmen sollte. Er stellt
 * sicher, was sonst jede Aufrufstelle einzeln bedenken müsste: dass der
 * Kontoschlüssel den Wechsel überlebt.
 *
 * DER FUND DAHINTER: eine Oberfläche zum Passwortwechsel gibt es in dieser
 * App im Augenblick nicht. `/api/auth/password` existiert, `api.change-
 * Password` existiert, `settings.changePassword` steht in allen 22
 * Wörterbüchern — aber es gibt keinen Aufrufer. Der Weg ist hier deshalb
 * vollständig verkabelt und nicht nur "vorbereitet": er läuft, sobald jemand
 * ihn ruft, und der Prüflauf ruft ihn.
 */
export async function passwortWechseln(userId: string, altes: string, neues: string): Promise<void> {
  const blob = await kontoSchluesselUmschliessen(userId, altes, neues);
  await api.changePassword(altes, neues, blob);
  /* Der Kontoschlüssel selbst hat sich nicht geändert — nur seine Hülle.
     Im Speicher bleibt deshalb alles, wie es war, und genau das ist der
     Sinn: kein Gerät verliert durch einen Passwortwechsel den Zugriff. */
}

/* ── Notizschlüssel ein- und auspacken ────────────────────────── */

/**
 * Der Umschlag für genau eine Notiz in genau einer Schlüsselfassung.
 *
 * Aus dem Kontoschlüssel abgeleitet statt er selbst: derselbe Kontoschlüssel
 * verschließt sonst zweihundert Notizen mit demselben Wert, und ein einziges
 * wiederverwendetes IV kostete dann alle auf einmal. Dieselbe Überlegung wie
 * beim Kontext in paketKontext() (lib/vertraulich.ts).
 */
async function notizHuelle(notizId: string, fassung: number): Promise<CryptoKey> {
  if (!kontoRoh) throw new Error('kein Kontoschlüssel');
  const zwischen = await crypto.subtle.importKey('raw', kontoRoh, 'HKDF', false, ['deriveKey']);
  return crypto.subtle.deriveKey(
    {
      name: 'HKDF', hash: 'SHA-256',
      salt: await sha256(notizKontoKontext(notizId, fassung)),
      info: enc.encode('stellium/notiz/konto/v1'),
    },
    zwischen, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt'],
  );
}

/** Einen Notizschlüssel mit dem Kontoschlüssel verpacken. */
export async function notizKontoPacken(
  notizKey: CryptoKey, notizId: string, fassung: number,
): Promise<KontoPaket> {
  const roh = await crypto.subtle.exportKey('raw', notizKey);
  const huelle = await notizHuelle(notizId, fassung);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const daten = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, huelle, roh);
  return {
    alg: KONTO_PAKET_ALG, kontoFassung: kontoFassungHier,
    iv: b64u(iv), daten: b64u(new Uint8Array(daten)),
  };
}

/**
 * Und wieder auf. Kein Absender, kein Nachschlagen eines öffentlichen Teils,
 * kein Gerät — wer den Kontoschlüssel hat, packt aus. Das ist der ganze
 * Unterschied zum Geräteweg und der ganze Grund für diese Datei.
 */
export async function notizKontoAuspacken(
  paket: KontoPaket, notizId: string, fassung: number,
): Promise<CryptoKey> {
  const huelle = await notizHuelle(notizId, fassung);
  const roh = await crypto.subtle.decrypt(
    { name: 'AES-GCM', iv: unb64u(paket.iv) }, huelle, unb64u(paket.daten),
  );
  return crypto.subtle.importKey('raw', roh, { name: 'AES-GCM', length: 256 }, true, ['encrypt', 'decrypt']);
}

/* ── Tresorschlüssel ein- und auspacken ───────────────────────────
 *
 * Wortgleiche Rechnung zum Notizschlüssel oben, eigener Kontext
 * (passwortKontoKontext statt notizKontoKontext) — derselbe Grund wie bei
 * jedem eigenen Kontext im Haus: ein Tresor-Kontopaket darf mit einem
 * Notiz-Kontopaket rechnerisch nichts gemein haben, selbst wenn beide
 * zufällig dieselbe Kennung und Fassung trügen. */
async function passwortHuelle(eintragId: string, fassung: number): Promise<CryptoKey> {
  if (!kontoRoh) throw new Error('kein Kontoschlüssel');
  const zwischen = await crypto.subtle.importKey('raw', kontoRoh, 'HKDF', false, ['deriveKey']);
  return crypto.subtle.deriveKey(
    {
      name: 'HKDF', hash: 'SHA-256',
      salt: await sha256(passwortKontoKontext(eintragId, fassung)),
      info: enc.encode('stellium/passwort/konto/v1'),
    },
    zwischen, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt'],
  );
}

/** Einen Tresor-Eintragsschlüssel mit dem Kontoschlüssel verpacken. */
export async function passwortKontoPacken(
  eintragKey: CryptoKey, eintragId: string, fassung: number,
): Promise<KontoPaket> {
  const roh = await crypto.subtle.exportKey('raw', eintragKey);
  const huelle = await passwortHuelle(eintragId, fassung);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const daten = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, huelle, roh);
  return {
    alg: KONTO_PAKET_ALG, kontoFassung: kontoFassungHier,
    iv: b64u(iv), daten: b64u(new Uint8Array(daten)),
  };
}

export async function passwortKontoAuspacken(
  paket: KontoPaket, eintragId: string, fassung: number,
): Promise<CryptoKey> {
  const huelle = await passwortHuelle(eintragId, fassung);
  const roh = await crypto.subtle.decrypt(
    { name: 'AES-GCM', iv: unb64u(paket.iv) }, huelle, unb64u(paket.daten),
  );
  return crypto.subtle.importKey('raw', roh, { name: 'AES-GCM', length: 256 }, true, ['encrypt', 'decrypt']);
}

/* ── Der Notzugang: eine ZWEITE Hülle um denselben Schlüssel ───────────────
 *
 * Alles hier oben hängt am Passwort. Das ist richtig und es ist die Grenze:
 * wer sein Passwort vergisst und kein angemeldetes Gerät mehr hat, kommt an
 * keine Notiz und keinen Tresoreintrag mehr. Der Notzugang
 * (lib/notzugang.ts) legt deshalb eine zweite Hülle um GENAU DIESELBEN 32
 * Bytes — verschlossen mit einem Notschlüssel, der in fünf Anteile zerlegt
 * bei fünf Menschen liegt.
 *
 * DIE ZAHL, DIE SICH NICHT BEWEGEN DARF: `fassung`. Sie zählt nur bei einem
 * ECHTEN Schlüsselwechsel hoch, und jedes Notiz- und Tresorpaket trägt sie
 * mit. Beide Funktionen unten rühren sie deshalb nicht an: die Hülle ist
 * neu, der Schlüssel ist derselbe, und der Server erkennt das am Abdruck
 * (services/kontoschluessel.ts, hinterlegenInTransaktion()).
 *
 * WARUM DIE ROHEN BYTES DIESE DATEI NICHT VERLASSEN: `kontoRoh` ist hier
 * absichtlich modulprivat. Die beiden Funktionen unten nehmen den
 * Notschlüssel entgegen und geben eine Hülle bzw. einen Wahrheitswert
 * zurück — nie den Kontoschlüssel selbst. Eine Ausfuhr „gib mir mal die
 * rohen Bytes" wäre der vierte Weg, vor dem der Kopf dieser Datei warnt. */

/** Aus dem Notschlüssel dieselbe Art Hülle wie aus dem Passwort — anderer
 *  Kontext, damit die beiden Ableitungen rechnerisch nichts gemein haben. */
async function notschluesselHuelle(
  notschluessel: Uint8Array<ArrayBuffer>, userId: string,
): Promise<CryptoKey> {
  const zwischen = await crypto.subtle.importKey('raw', notschluessel, 'HKDF', false, ['deriveKey']);
  return crypto.subtle.deriveKey(
    {
      name: 'HKDF', hash: 'SHA-256',
      salt: await sha256(notzugangKekKontext(userId)),
      info: enc.encode('stellium/notzugang/kek/v1'),
    },
    zwischen, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt'],
  );
}

/**
 * Den Kontoschlüssel dieses Geräts mit einem Notschlüssel verschließen.
 *
 * `null`, wenn dieses Gerät gerade keinen Kontoschlüssel hat — dann gibt es
 * nichts zu sichern, und eine Hülle um nichts wäre schlimmer als keine.
 */
export async function notzugangHuelleErzeugen(
  userId: string, notschluessel: Uint8Array<ArrayBuffer>,
): Promise<NotzugangHuelle | null> {
  if (!kontoRoh || kontoUserId !== userId || !kontoFassungHier) return null;
  const huelle = await notschluesselHuelle(notschluessel, userId);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const daten = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, huelle, kontoRoh);
  return {
    alg: KONTO_PAKET_ALG, iv: b64u(iv), daten: b64u(new Uint8Array(daten)),
    kontoAbdruck: await abdruckVon(kontoRoh),
    kontoFassung: kontoFassungHier,
    schwelle: NOTZUGANG_SCHWELLE, anteile: NOTZUGANG_ANTEILE,
  };
}

/**
 * Den Kontoschlüssel aus der Nothülle zurückholen und für das HEUTIGE
 * Passwort neu verschließen.
 *
 * Der Weg in drei Schritten, und der mittlere ist der, auf den es ankommt:
 *
 *   1. Nothülle auf. Geht sie nicht auf, war der zusammengesetzte
 *      Notschlüssel falsch — abbrechen, nichts anfassen.
 *   2. ABDRUCK VERGLEICHEN. Kommt ein anderer Schlüssel heraus als der, den
 *      der Server unter diesem Abdruck kennt, wird NICHT hinterlegt. Sonst
 *      liefe die Hinterlegung in den Ersatzzweig und räumte jedes Notiz- und
 *      Tresorpaket weg — die Wiederherstellung würde genau das zerstören,
 *      wofür es sie gibt.
 *   3. Mit dem heutigen Passwort neu umschließen und hinterlegen. Derselbe
 *      Abdruck heißt für den Server: umschließen, nicht ersetzen. `fassung`
 *      bleibt stehen, und damit bleibt jedes Paket gültig.
 *
 * Das Passwort kommt von der Person, nicht aus dem Speicher: nach der
 * Anmeldung liegt es nirgends mehr, und das soll so bleiben (siehe Kopf
 * dieser Datei — es gibt genau drei Stellen, an denen es im Klartext
 * vorliegt, und alle drei fragen danach).
 */
export async function mitNotschluesselWiederherstellen(
  userId: string, passwort: string,
  huelle: NotzugangHuelle, notschluessel: Uint8Array<ArrayBuffer>,
): Promise<boolean> {
  let roh: Uint8Array<ArrayBuffer>;
  try {
    const kek = await notschluesselHuelle(notschluessel, userId);
    roh = new Uint8Array(await crypto.subtle.decrypt(
      { name: 'AES-GCM', iv: unb64u(huelle.iv) }, kek, unb64u(huelle.daten),
    ));
  } catch {
    return false;
  }

  /* Jeder Ausgang außer dem gelungenen nullt `roh`.
     Die drei Fehlschläge unten gaben den zurückgeholten KONTOSCHLÜSSEL
     einfach frei — 32 rohe Bytes, die bis zur nächsten Speicherbereinigung
     im Prozess stehen und die danach niemand mehr löschen kann. Nur der
     gelungene Weg darf sie behalten, denn dort werden sie zu `kontoRoh`;
     `gelungen` sagt genau das und nichts anderes. */
  let gelungen = false;
  try {
    if (await abdruckVon(roh) !== huelle.kontoAbdruck) return false;
    const blob = await umschliessen(roh, passwort, userId);
    const { fassung } = await api.kontoSchluesselHinterlegen(blob);
    /* Die Zahl vom Server und nicht die aus der Hülle: sie ist der Beweis,
       dass er es als Umschließen verstanden hat. Käme eine höhere zurück,
       wäre der Ersatzzweig gelaufen — dann sind die Pakete ohnehin weg, und
       weiterzumachen, als wäre nichts, wäre die schlechteste aller
       Antworten. */
    if (fassung !== huelle.kontoFassung) return false;
    kontoRoh = roh; kontoFassungHier = fassung; kontoUserId = userId;
    ablegen({ userId, fassung, roh: b64u(roh) });
    gelungen = true;
    return true;
  } catch {
    return false;
  } finally {
    if (!gelungen) roh.fill(0);
  }
}
