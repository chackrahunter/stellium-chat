/**
 * Gemeinsame Sprache für vertrauliche Kanäle und private Dateien.
 *
 * Server und App müssen sich über die Form der Chiffrate einig sein, ohne
 * dass der Server je einen Schlüssel besitzt. Deshalb liegt hier nur das
 * Vokabular: wie ein Chiffrat aussieht, woran man es erkennt, wie ein
 * Freigabecode gebaut ist. Gerechnet wird auf beiden Seiten woanders — in der
 * App mit der Web Crypto API, auf dem Server gar nicht.
 *
 * Diese Datei wird auch im Browser geladen. Deshalb steht hier nichts aus
 * node:crypto, sondern ausschließlich Zeichenkettenarbeit.
 */

/**
 * Kennung am Anfang jedes Ende-zu-Ende-Chiffrats.
 *
 * Sie steht bewusst vorn und nicht in einer eigenen Spalte: der Server reicht
 * Nachrichtentexte durch Dutzende Stellen, und an jeder davon muss ohne
 * Zusatzwissen erkennbar sein, dass hier nichts Lesbares steht. Eine Spalte
 * hätte man an einer dieser Stellen vergessen.
 */
export const E2E_PREFIX = 'e1:';

/** Dasselbe für Dateien. Eigene Kennung, weil das Format ein anderes ist. */
export const E2E_DATEI_PREFIX = 'd1:';

/* ── Verschlüsselte Dateien ───────────────────────────────────── */

/**
 * Wem der Schlüssel einer Datei gehört.
 *
 * Das ist die Entscheidung, um die sich bei Dateien alles dreht. Der
 * Dateischlüssel ist **immer Zufall** und wird nie aus dem Inhalt abgeleitet
 * (siehe `dateiVerschluesseln` in der App). Die Frage ist deshalb nicht,
 * woraus er entsteht, sondern womit er verschlossen wird — und damit, wer ihn
 * öffnen kann:
 *
 *   `kanal`  Verschlossen mit dem Kanalschlüssel einer bestimmten Fassung.
 *            Öffnen kann ihn genau der Kreis, der auch die Nachrichten des
 *            Kanals liest. Für Anhänge in vertraulichen Kanälen.
 *
 *   `konto`  Verschlossen mit einem Schlüssel, den nur das eigene
 *            Schlüsselpaar hergibt. Öffnen kann ihn niemand sonst — auch kein
 *            anderes Mitglied. Für private Dateien in der Ablage.
 *
 * Die Angabe steht offen im Umschlag, weil sie kein Geheimnis ist, sondern
 * eine Wegbeschreibung: ohne sie wüsste eine App nicht, welchen Schlüssel sie
 * überhaupt probieren soll. Der Server liest sie mit und nutzt sie, um zu
 * prüfen, dass ein Anhang wirklich für **diesen** Kanal verschlossen wurde.
 */
export type DateiHuelle =
  | { art: 'kanal'; channelId: string; fassung: number }
  | { art: 'konto'; userId: string };

/**
 * Der offene Umschlag einer verschlüsselten Datei.
 *
 * Er steht als eine Zeile am Anfang der Datei — `d1:<b64u(JSON)>\n` —, danach
 * kommen die Stücke. Alles darin ist entweder öffentlich (welche Hülle, wie
 * groß ein Stück) oder selbst verschlossen (der Dateischlüssel, der Kopf mit
 * Name und Typ).
 *
 * Warum der Umschlag mit in die Datei gehört und nicht in eine Spalte: eine
 * Datei ohne ihren Umschlag ist ein Haufen Bytes, den niemand mehr öffnen
 * kann. Läge er in der Datenbank, hinge die Lesbarkeit an einer Zeile, die bei
 * jedem Umzug, jeder Sicherung und jeder Nachrüstung mitwandern müsste. So
 * trägt die Datei alles bei sich, was zu ihr gehört — bis auf den einen
 * Schlüssel, den der Server nie hat.
 */
export interface DateiUmschlag {
  /** Immer "aes-gcm". Steht dabei, damit ein späterer Wechsel des Verfahrens
   *  alte Dateien nicht unlesbar macht, sondern erkennbar. */
  alg: 'aes-gcm';
  /** Stückgröße im Klartext. Der Leser braucht sie nicht, der Mensch schon:
   *  an ihr sieht man, wie eine Datei zerlegt wurde. */
  stueck: number;
  huelle: DateiHuelle;
  /** Der Dateischlüssel, verschlossen mit der Hülle. */
  schluesselIv: string;
  schluessel: string;
  /** Name, Typ und Größe — verschlossen mit dem Dateischlüssel.
   *  Sie stehen nicht offen da, weil "Kündigung Meier.pdf" den Inhalt verrät,
   *  ohne dass jemand die Datei öffnen müsste. */
  kopfIv: string;
  kopf: string;
}

/** DateiUmschlag → "d1:<b64u(JSON)>". Ohne den Zeilenumbruch dahinter. */
export function umschlagSchreiben(u: DateiUmschlag, b64u: (s: string) => string): string {
  return `${E2E_DATEI_PREFIX}${b64u(JSON.stringify(u))}`;
}

/**
 * Umkehrung — und zugleich die Prüfung, ob hier wirklich ein Umschlag steht.
 *
 * Gibt null zurück, sobald irgendetwas nicht stimmt. Das ist der Grund, warum
 * diese Funktion mehr tut als nur zu parsen: der Server entscheidet an ihrem
 * Ergebnis, ob eine hochgeladene Datei als verschlüsselt gilt. Eine Zusage,
 * die sich auf "der Client hat es behauptet" stützt, wäre keine — deshalb wird
 * am Inhalt selbst nachgesehen, genau wie bei `istE2EChiffrat` für Texte.
 *
 * `unb64u` kommt von außen, weil diese Datei auch im Browser läuft und dort
 * kein Buffer zur Verfügung steht.
 */
export function umschlagLesen(
  zeile: string | null | undefined,
  unb64u: (s: string) => string,
): DateiUmschlag | null {
  if (!zeile || !zeile.startsWith(E2E_DATEI_PREFIX)) return null;
  try {
    const roh = JSON.parse(unb64u(zeile.slice(E2E_DATEI_PREFIX.length))) as DateiUmschlag;
    if (!roh || roh.alg !== 'aes-gcm') return null;
    if (!Number.isInteger(roh.stueck) || roh.stueck <= 0) return null;
    if (!roh.schluessel || !roh.schluesselIv || !roh.kopf || !roh.kopfIv) return null;
    const h = roh.huelle;
    if (!h) return null;
    if (h.art === 'kanal') {
      if (!h.channelId || !Number.isInteger(h.fassung) || h.fassung < 1) return null;
    } else if (h.art === 'konto') {
      if (!h.userId) return null;
    } else {
      return null;
    }
    return roh;
  } catch {
    return null;
  }
}

/**
 * Ist das ein Ende-zu-Ende-Chiffrat?
 *
 * Der Server benutzt das als Sicherung: was so aussieht, darf nicht an
 * Übersetzung, Zusammenfassung oder Volltextindex weitergereicht werden. Die
 * Prüfung am Kanal wäre der genauere Weg, aber sie hilft nicht, wenn eine
 * Nachricht aus einem vertraulichen Kanal weitergereicht wird — hier greift
 * sie am Inhalt selbst.
 */
export function istE2EChiffrat(text: string | null | undefined): boolean {
  return Boolean(text && text.startsWith(E2E_PREFIX));
}

/**
 * Nutzlast einer verschlüsselten Nachricht.
 *
 * `fassung` sagt, mit welcher Fassung des Kanalschlüssels sie verschlossen
 * wurde. Ohne diese Angabe wäre jede Schlüsselrotation ein Bruch: alte
 * Nachrichten ließen sich nach dem Entfernen eines Mitglieds nicht mehr lesen,
 * obwohl der alte Schlüssel noch in jeder App liegt.
 */
export interface E2ENutzlast {
  fassung: number;
  iv: string;
  daten: string;
}

/** E2ENutzlast → "e1:<fassung>:<iv>:<daten>". */
export function nutzlastSchreiben(n: E2ENutzlast): string {
  return `${E2E_PREFIX}${n.fassung}:${n.iv}:${n.daten}`;
}

/** Umkehrung. Gibt null zurück, wenn die Form nicht stimmt. */
export function nutzlastLesen(text: string | null | undefined): E2ENutzlast | null {
  if (!istE2EChiffrat(text)) return null;
  const teile = (text as string).slice(E2E_PREFIX.length).split(':');
  if (teile.length !== 3) return null;
  const fassung = Number(teile[0]);
  if (!Number.isInteger(fassung) || fassung < 1) return null;
  if (!teile[1] || !teile[2]) return null;
  return { fassung, iv: teile[1], daten: teile[2] };
}

/**
 * Ein für ein einzelnes Konto verpackter Schlüssel.
 *
 * `von` ist das Konto, dessen öffentlicher Teil beim Aushandeln mitgewirkt hat.
 * Ohne diese Angabe könnte die empfangende App das gemeinsame Geheimnis nicht
 * nachbilden — sie wüsste nicht, mit wem sie es teilt.
 */
export interface SchluesselPaket {
  /** Immer "ecdh-p256+aes-gcm". Steht mit dabei, damit ein späterer Wechsel
   *  des Verfahrens alte Pakete nicht unlesbar macht, sondern erkennbar. */
  alg: string;
  von: string;
  iv: string;
  daten: string;
}

export const PAKET_ALG = 'ecdh-p256+aes-gcm';

/**
 * Zeichenvorrat für Freigabecodes und Wiederherstellungscodes.
 *
 * Ohne 0/O und 1/I/L, weil beide Codes vorgelesen oder abgeschrieben werden —
 * derselbe Grund wie beim Einmal-Passwort in services/users.ts.
 */
export const CODE_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';

/** Form eines Freigabecodes: zwei Dreiergruppen, z.B. K7M-2QX. */
export const FREIGABE_CODE_MUSTER = /^[ABCDEFGHJKMNPQRSTUVWXYZ23456789]{3}-[ABCDEFGHJKMNPQRSTUVWXYZ23456789]{3}$/;

/**
 * Codes werden vorgelesen, und dabei geht die Groß-/Kleinschreibung verloren.
 * Der Bindestrich auch. Beides hier einfangen, statt es der eintippenden
 * Person als Fehler zurückzugeben.
 */
export function codeNormalisieren(roh: string): string {
  const sauber = (roh ?? '').toUpperCase().replace(/[^A-Z0-9]/g, '');
  return sauber.length === 6 ? `${sauber.slice(0, 3)}-${sauber.slice(3)}` : sauber;
}

export function istFreigabeCode(roh: string): boolean {
  return FREIGABE_CODE_MUSTER.test(codeNormalisieren(roh));
}

/**
 * Wiederherstellungscode: sechs Vierergruppen.
 *
 * Er schützt den privaten Schlüssel eines ganzen Kontos und muss deshalb
 * deutlich mehr aushalten als ein Freigabecode, der nur wenige Tage gilt und
 * bei falscher Eingabe schnell gesperrt wird. 31^24 liegt jenseits von allem,
 * was sich durchprobieren lässt.
 */
export const WIEDERHERSTELLUNG_GRUPPEN = 6;
export const WIEDERHERSTELLUNG_GRUPPENLAENGE = 4;

export function wiederherstellungNormalisieren(roh: string): string {
  const sauber = (roh ?? '').toUpperCase().replace(/[^A-Z0-9]/g, '');
  const teile: string[] = [];
  for (let i = 0; i < sauber.length; i += WIEDERHERSTELLUNG_GRUPPENLAENGE) {
    teile.push(sauber.slice(i, i + WIEDERHERSTELLUNG_GRUPPENLAENGE));
  }
  return teile.join('-');
}

export function istWiederherstellungscode(roh: string): boolean {
  const sauber = (roh ?? '').toUpperCase().replace(/[^A-Z0-9]/g, '');
  if (sauber.length !== WIEDERHERSTELLUNG_GRUPPEN * WIEDERHERSTELLUNG_GRUPPENLAENGE) return false;
  return [...sauber].every((z) => CODE_ALPHABET.includes(z));
}

/* ── Freigaben bei Vorfällen ──────────────────────────────────── */

/** Wie lange eine Freigabe gilt, wenn niemand etwas anderes wählt. */
export const FREIGABE_TAGE_VORGABE = 14;
export const FREIGABE_TAGE_HOECHSTENS = 90;

/**
 * Wie oft ein Code falsch eingegeben werden darf.
 *
 * Sechs Zeichen aus 31 sind knapp neunhundert Millionen Möglichkeiten — für
 * einen Menschen unerreichbar, für ein Skript nicht. Nach acht Fehlversuchen
 * ist die Freigabe deshalb verbrannt und muss neu erteilt werden.
 */
export const FREIGABE_VERSUCHE = 8;

export interface Freigabe {
  id: string;
  channelId: string;
  /** Fassung des Kanalschlüssels, die freigegeben wurde. */
  fassung: number;
  /** Wer den Vorfall gemeldet hat. */
  melderId: string;
  grund: string;
  erstelltAm: number;
  laeuftAb: number;
  zurueckgenommenAm: number | null;
  /** Wie viele Fehlversuche der Code schon hatte. */
  fehlversuche: number;
  /** Nur für die meldende Person: der Code steht sonst nirgends mehr. */
  code?: string;
}

/** Was die Verwaltung nach Eingabe des Codes bekommt. */
export interface FreigabeSchluessel {
  freigabeId: string;
  channelId: string;
  fassung: number;
  /** Doppelt verschlossen: außen der Code, innen der eigene Schlüssel. */
  paket: SchluesselPaket;
}

/* ── Öffentliche Schlüssel ────────────────────────────────────── */

export interface OeffentlicherSchluessel {
  userId: string;
  /** JWK des öffentlichen ECDH-Teils, als Zeichenkette. */
  jwk: string;
  /**
   * Kurzer Abdruck zum Vorlesen. Wer sichergehen will, dass niemand
   * dazwischensitzt, vergleicht ihn mündlich — der Server könnte sonst einen
   * eigenen Schlüssel unterschieben und mitlesen.
   */
  abdruck: string;
  erstelltAm: number;
}

/**
 * Was in einem vertraulichen Kanal abgeschaltet ist.
 *
 * Die Liste steht hier und nicht verstreut im Server, damit die Oberfläche
 * dieselbe Auskunft geben kann, die der Server durchsetzt — und damit beim
 * Hinzufügen einer neuen KI-Funktion auffällt, dass sie hier fehlt.
 */
export const VERTRAULICH_ABGESCHALTET = [
  'uebersetzung', 'zusammenfassung', 'antwortvorschlaege',
  'serversuche', 'aufgabenerkennung', 'assistent', 'linkvorschau', 'transkript',
  'vorschlaege',
  /**
   * Emoji-Reaktionsvorschläge — deckt hier den KI-Rückfall ab (ai:reaction-
   * suggest, siehe ws/gateway.ts: klartextNoetigFuerNachricht weist ihn ab).
   * Der eigentliche, örtliche Abgleich (packages/desktop/src/emoji/katalog.ts)
   * verlässt das Gerät nie und bräuchte diese Sperre technisch nicht — er wird
   * in vertraulichen Kanälen trotzdem mit abgeschaltet (siehe MessageItem.tsx),
   * damit die Reaktionsleiste dort durchgehend so aussieht, wie sie sich
   * anfühlen soll: nichts Automatisches rührt den Text an, ausnahmslos.
   */
  'reaktionsvorschlaege',
] as const;
export type VertraulichAbgeschaltet = (typeof VERTRAULICH_ABGESCHALTET)[number];

/* ── Der Kontoschlüssel ───────────────────────────────────────── */

/**
 * WARUM ES DIESEN SCHLÜSSEL ÜBERHAUPT GIBT
 *
 * Ein `SchluesselPaket` trägt in `von` eine KONTO-Kennung, gerechnet wurde
 * es aber mit dem privaten ECDH-Teil EINES BESTIMMTEN GERÄTS. Das ist kein
 * Schönheitsfehler, das ist eine Verwechslung: zwei Geräte desselben Kontos
 * sind kryptografisch zwei verschiedene Gegenüber, die Ablage
 * (`notiz_schluessel_pakete`, Primärschlüssel `(notiz_id, user_id)`) kennt
 * aber nur eines je Konto. Wer auf dem Mac eine Notiz anlegt, packt sie für
 * den privaten Teil DES MACS — das Handy schlägt beim Auspacken den
 * öffentlichen Teil "des Kontos" nach, bekommt seinen EIGENEN und kann die
 * Rechnung nie nachbilden. Genau das war der gemeldete Fehler.
 *
 * Der Kontoschlüssel hebt die Verwechslung auf: ein zufälliger AES-Schlüssel,
 * der dem KONTO gehört, nicht einem Gerät. Er liegt beim Server nur
 * verschlossen — verschlossen mit einem Schlüssel, den jedes Gerät aus dem
 * Passwort selbst herleitet und der den Server nie erreicht. Damit kann
 * jedes angemeldete Gerät desselben Kontos denselben Kontoschlüssel
 * herstellen, ohne dass irgendein Gerät mit irgendeinem anderen sprechen
 * müsste.
 *
 * Der Geräteweg (ECDH) bleibt vollständig erhalten und wird nicht ersetzt.
 * Zwei unabhängige Wege zum selben Notizschlüssel heißen: ein Ausfall auf
 * einem Weg kostet keine Notiz.
 */

/** Wie der Passwortschlüssel abgeleitet wird. Steht mit in der Zeile, damit
 *  ein späterer Wechsel alte Sicherungen nicht unlesbar macht, sondern
 *  erkennbar. */
export const KONTO_KDF = 'pbkdf2-sha256';

/**
 * Runden für die Ableitung aus dem Passwort.
 *
 * Bewusst höher als die 310.000 bei `codeSchluessel()` in
 * lib/vertraulich.ts, und der Unterschied ist kein Versehen: dort schützt
 * die Ableitung einen ZUFÄLLIGEN Code aus 24 Zeichen (31^24, jenseits von
 * allem Durchprobieren) — die Rundenzahl ist dort fast bedeutungslos. Hier
 * schützt sie ein von einem Menschen ausgedachtes Passwort, und dann ist sie
 * das Einzige, was zwischen einer gestohlenen Datenbanksicherung und den
 * Notizen steht.
 *
 * 600.000 ist die heutige OWASP-Empfehlung für PBKDF2-HMAC-SHA256. Auf einem
 * alten Telefon kostet das ein bis zwei Sekunden — einmal je Anmeldung, nicht
 * je Notiz. Die Zahl steht trotzdem in jeder Zeile mit dabei (`runden`) und
 * nicht nur hier: wird sie später erhöht, bleiben ältere Sicherungen mit
 * ihrer eigenen Zahl weiter lesbar.
 *
 * PBKDF2 und nicht Argon2id, obwohl Argon2id das bessere Verfahren wäre: die
 * Web Crypto API kennt nur PBKDF2. Argon2id hieße ein WASM-Paket im Startweg
 * jeder Anmeldung, und seine speicherharten Parameter (64 MB) sind genau
 * das, was ein altes Telefon nicht übrig hat.
 */
export const KONTO_RUNDEN = 600_000;

/**
 * Der Kontoschlüssel, wie er beim Server liegt — verschlossen.
 *
 * `salz` und `runden` sind keine Geheimnisse, sondern Wegbeschreibung: ohne
 * sie wüsste ein zweites Gerät nicht, wie es aus demselben Passwort denselben
 * Schlüssel bekommt. `daten` ist der Kontoschlüssel selbst, verschlossen —
 * für den Server ein Haufen Bytes.
 *
 * `fassung` zählt bei jedem ERSATZ hoch (neuer Kontoschlüssel), nicht beim
 * bloßen Umschließen nach einem Passwortwechsel — dort bleibt derselbe
 * Kontoschlüssel, nur seine Hülle wechselt. Daran hängt die Sicherung gegen
 * das gefährlichste Missgeschick dieses Entwurfs: ein Gerät mit einem VERALTETEN
 * Kontoschlüssel darf kein Notizpaket schreiben, das echt aussieht und
 * niemand öffnen kann (siehe `KontoPaket.kontoFassung`).
 *
 * `abdruck` ist SHA-256 über den rohen Kontoschlüssel mit einem eigenen
 * Vorspann. Er verrät den Schlüssel nicht (256 Bit Zufall lassen sich nicht
 * zurückrechnen), erlaubt dem Server aber, beim Umschließen zu prüfen, dass
 * wirklich DERSELBE Schlüssel neu verpackt wurde — ohne ihn je zu sehen.
 */
export interface KontoSchluesselBlob {
  kdf: string;
  salz: string;
  runden: number;
  alg: string;
  iv: string;
  daten: string;
  fassung: number;
  abdruck: string;
}

/**
 * Ein Notizschlüssel, verpackt mit dem Kontoschlüssel statt mit ECDH.
 *
 * Kein `von`: es gibt hier kein Gegenüber. Wer den Kontoschlüssel hat, packt
 * aus — das ist der ganze Punkt.
 *
 * `kontoFassung` sagt, MIT WELCHEM Kontoschlüssel verpackt wurde. Der Server
 * nimmt nur Pakete an, deren Zahl zur aktuellen Zeile passt, und wirft beim
 * Ersetzen des Kontoschlüssels alle alten Pakete weg. Beides zusammen sorgt
 * dafür, dass eine Zeile in der Datenbank nie „gesund aussieht", ohne
 * öffenbar zu sein.
 */
export interface KontoPaket {
  alg: string;
  kontoFassung: number;
  iv: string;
  daten: string;
}

export const KONTO_PAKET_ALG = 'aes-gcm';

/**
 * Die Kontexte der beiden Ableitungen — an einer Stelle, weil App, Server-
 * Prüflauf und jede spätere Fassung sie zeichengleich bilden müssen.
 * Dieselbe Überlegung wie bei `paketKontext()` in lib/vertraulich.ts, nur
 * dass sie hier über Paketgrenzen hinweg gebraucht werden.
 */
export function kontoKekKontext(userId: string): string {
  return `stellium/konto/kek/v1/${userId}`;
}

/** Je Notiz und Schlüsselfassung ein eigener Umschlag aus dem Kontoschlüssel
 *  — derselbe Kontoschlüssel verschließt nie zweimal dasselbe. */
export function notizKontoKontext(notizId: string, fassung: number): string {
  return `stellium/notiz/konto/${notizId}/${fassung}`;
}

/** Derselbe Gedanke wie {@link notizKontoKontext}, für den Passwort-Tresor —
 *  eigenes Präfix, damit ein Kontopaket eines Tresoreintrags nie mit dem
 *  einer Notiz verwechselt werden kann, selbst wenn beide zufällig dieselbe
 *  Kennung trügen (kann nicht vorkommen, siehe die Kennungsvorsätze "nz_"
 *  und "pw_", ist aber trotzdem keine Rechnung, die sich zwei Verwendungen
 *  teilen sollten). */
export function passwortKontoKontext(eintragId: string, fassung: number): string {
  return `stellium/passwort/konto/${eintragId}/${fassung}`;
}

/** Vorspann des Abdrucks. Eigener Text, damit der Abdruck nie mit
 *  irgendeiner anderen Ableitung aus demselben Schlüssel zusammenfällt. */
export const KONTO_ABDRUCK_VORSPANN = 'stellium/konto/abdruck/v1';

/* ── Der Anmeldenachweis ───────────────────────────────────────────────────

   DAS LOCH, DAS DIESER ABSCHNITT ZUSTOPFT

   Der Kontoschlüssel weiter oben leitet seine Hülle aus dem PASSWORT ab.
   Das ist die einzige Gemeinsamkeit aller Geräte eines Kontos und deshalb
   richtig — aber es hängt an einer Bedingung, die bisher nicht galt: dass
   das Passwort den Server nie erreicht. `POST /api/auth/login` schickte es
   im Klartext hin. Ein Server, der in diesem Augenblick mitschriebe, könnte
   denselben Kontoschlüssel herleiten wie jedes Gerät — und damit jede
   Notiz öffnen, die der Kontoschlüssel schützt. Genau das steht als
   ehrliche Einschränkung im Kopf von desktop/src/lib/kontoschluessel.ts.

   WAS STATTDESSEN ÜBER DIE LEITUNG GEHT

   Ein Nachweis: PBKDF2 über das Passwort mit einem kontoeigenen Salz,
   danach HKDF mit einer ausgeschriebenen Zweckangabe. Der Server hasht ihn
   wie bisher mit scrypt und legt ihn ab — für ihn ist er eine
   undurchsichtige Zeichenkette, mit der er nichts anderes tun kann als
   vergleichen.

   WAS DAS EHRLICHERWEISE NICHT LEISTET

   Der Nachweis ist passwortgleich in dem Sinn, dass er ALLEIN zum Anmelden
   genügt: wer ihn von der Leitung abfängt, kommt herein. Er ist aber NICHT
   passwortgleich in dem Sinn, der hier zählt — aus ihm lässt sich der
   Kontoschlüssel-KEK nicht herleiten, denn dafür bräuchte man das Passwort
   selbst, und PBKDF2 lässt sich nicht rückwärts rechnen. Genau das ist der
   Zweck: der Tresor überlebt eine mitgeschriebene Anmeldung.

   WARUM DIE ZAHL KLEINER IST ALS BEI KONTO_RUNDEN

   Über dem Nachweis liegt beim Server noch scrypt (N=16384) — ein Dieb der
   Datenbank rechnet also beides. Und der Nachweis bewacht keine Notiz,
   sondern nur die Tür; hinter der Tür steht der Kontoschlüssel mit seinen
   eigenen 600.000 Runden. Diese Zahl kostet jede Anmeldung zusätzliche
   Zeit auf einem alten Telefon, und die 600.000 des Kontoschlüssels fallen
   in derselben Anmeldung ohnehin an. 210.000 ist die OWASP-Empfehlung für
   PBKDF2-HMAC-SHA256 in der Fassung, die keinen zweiten Faktor
   voraussetzt.

   WARUM DIE ZAHL NICHT IN DER ZEILE MITSTEHT — anders als bei KONTO_RUNDEN

   Dort trägt jede Hülle ihre eigene Rundenzahl, weil eine Erhöhung sonst
   alte Hüllen unlesbar machte. Hier wäre eine mitgeführte Zahl ein
   Verräter: die Auskunft vor der Anmeldung müsste sie herausgeben, und
   dann unterschiede sich ein Konto mit alter Zahl von einem erfundenen
   Konto, das immer die neue bekommt. Wird die Zahl später erhöht, passt der
   gespeicherte Nachweis nicht mehr, die Anmeldung fällt auf den alten Weg
   zurück und das Gerät hinterlegt ihn mit der neuen Zahl neu — ein
   Anmeldevorgang je Person, kein einziger Ausschluss. Diese Selbstheilung
   ist der Grund, warum hier eine Konstante steht und keine Spalte. */

/** Wie der Nachweis abgeleitet wird. Steht in der Zeile mit, damit ein
 *  späterer Wechsel des Verfahrens erkennbar ist und nicht bloß schiefgeht. */
export const ANMELDE_KDF = 'pbkdf2-sha256';

/** Runden für die Ableitung des Nachweises — Begründung siehe oben. */
export const ANMELDE_RUNDEN = 210_000;

/**
 * Die Zweckangabe der zweiten Stufe.
 *
 * Nicht an die Kontokennung gebunden, und das ist Absicht: vor der
 * Anmeldung kennt das Gerät seine Kennung noch gar nicht, es kennt nur den
 * eingetippten Namen — und der kann derselbe Mensch mal als Benutzername,
 * mal als E-Mail sein. Was die Ableitung an das Konto bindet, ist das Salz;
 * dieser Text trennt sie nur von jeder anderen Ableitung aus demselben
 * Passwort, allen voran der des Kontoschlüssels (kontoKekKontext oben).
 */
export const ANMELDE_NACHWEIS_KONTEXT = 'stellium/anmeldung/nachweis/v1';

/**
 * Die Wegbeschreibung, die der Server VOR der Anmeldung herausgibt.
 *
 * Kein Geheimnis, sondern genau das, was ein zweites Gerät braucht, um aus
 * demselben Passwort denselben Nachweis zu bilden. Sie kommt für JEDEN
 * eingetippten Namen — auch für einen, zu dem es kein Konto gibt (dann
 * deterministisch aus einem Servergeheimnis erzeugt, siehe
 * services/anmeldenachweis.ts). Wer sie abfragt, erfährt deshalb nicht, ob
 * es das Konto gibt.
 */
export interface AnmeldeSalz {
  kdf: string;
  salz: string;
  runden: number;
}

/**
 * Was ein Gerät hinterlegt, sobald es sich einmal klassisch angemeldet hat.
 *
 * `salz` wählt das GERÄT, nicht der Server. Ein Server, der das Salz
 * vorgäbe, könnte allen Konten dasselbe geben und sich damit eine
 * vorgerechnete Tabelle bauen.
 */
export interface AnmeldeNachweisBlob {
  kdf: string;
  salz: string;
  runden: number;
  nachweis: string;
}

/* ── Der Notzugang: „3 von 5" ──────────────────────────────────────────────

   DER WIDERSPRUCH, DEN DIESER ABSCHNITT AUFLÖST

   Zwei Wünsche, die sich als Sätze widersprechen: „Wer sein Passwort vergisst
   und kein angemeldetes Gerät mehr hat, soll wieder an seine Notizen und
   seinen Tresor kommen" und „Niemand außer der besitzenden Person soll da je
   hineinsehen können". Wer wiederherstellen kann, kann lesen — das ist keine
   Frage der Umsetzung, sondern dasselbe Können.

   Aufgelöst wird er nicht, indem einer von beiden Sätzen aufgegeben wird,
   sondern indem KEINE EINZELNE PERSON beides kann: ein zufälliger
   Notschlüssel wird in fünf Anteile zerlegt (geheimnisteilung.ts), drei
   davon setzen ihn wieder zusammen, zwei ergeben nichts. Eine einzelne
   Verwaltung, ein gestohlenes Verwaltungskonto und eine gestohlene Platte
   ergeben je genau einen Anteil, und ein Anteil ist wertlos.

   WAS DER NOTSCHLÜSSEL AUFSCHLIESST — UND WAS NICHT

   Er schließt den KONTOSCHLÜSSEL auf, nicht das Passwort. Das ist die
   entscheidende Wahl: der Kontoschlüssel bleibt derselbe, er bekommt nur
   eine zweite Hülle. `fassung` (siehe KontoSchluesselBlob oben) darf sich
   dabei NICHT bewegen — sie zählt nur bei einem ECHTEN Schlüsselwechsel
   hoch, und jedes Notiz- und Tresorpaket trägt sie mit. Eine
   Wiederherstellung, die die Fassung anfasst, räumt genau das weg, was sie
   retten sollte.

   WAS DER SERVER SIEHT

   Bytes, wie überall hier. Er verwahrt den mit dem Notschlüssel
   verschlossenen Kontoschlüssel und fünf einzeln verschlossene Anteile. Den
   Notschlüssel selbst sieht er nie, drei Anteile im Klartext nie, den
   Kontoschlüssel nie. */

/** Wie viele Anteile zusammenkommen müssen. Die Zahl kommt vom Inhaber. */
export const NOTZUGANG_SCHWELLE = 3;

/** Wie viele Anteile es überhaupt gibt. */
export const NOTZUGANG_ANTEILE = 5;

/**
 * Vorspann des Notschlüssel-Abdrucks.
 *
 * Er liegt AUSSCHLIESSLICH innerhalb der verschlossenen Anteile und erreicht
 * den Server nie — anders als KONTO_ABDRUCK_VORSPANN, dessen Ergebnis der
 * Server bewusst kennt. Sein Zweck ist ein anderer: er ist das Einzige, woran
 * sich ein verfälschter Anteil erkennen lässt. Shamir selbst kann das nicht
 * (drei falsche Punkte legen genauso eine Kurve fest wie drei richtige) —
 * ohne diesen Abdruck käme aus einem verdrehten Anteil ein falscher Schlüssel
 * heraus, der aussieht wie ein richtiger.
 */
export const NOTZUGANG_ABDRUCK_VORSPANN = 'stellium/notzugang/abdruck/v1';

/** Aus dem Notschlüssel wird die Hülle um den Kontoschlüssel abgeleitet —
 *  an das Konto gebunden, damit eine vertauschte Zeile nichts ergibt. */
export function notzugangKekKontext(userId: string): string {
  return `stellium/notzugang/kek/v1/${userId}`;
}

/** Ein Anteil, verschlossen für genau eine haltende Person. */
export function notzugangAnteilKontext(userId: string, halterId: string): string {
  return `stellium/notzugang/anteil/${userId}>${halterId}`;
}

/** Ein Beitrag zu genau einer Anfrage, verschlossen für die anfragende
 *  Person. Die Anfragekennung steht mit drin: ein Beitrag aus einer früheren
 *  Wiederherstellung darf in einer späteren nicht mitzählen. */
export function notzugangBeitragKontext(anfrageId: string, halterId: string, userId: string): string {
  return `stellium/notzugang/beitrag/${anfrageId}/${halterId}>${userId}`;
}

/**
 * Ein Paket mit einem FLÜCHTIGEN Absender.
 *
 * Warum nicht SchluesselPaket mit `von`: dort rechnet die Gegenseite mit dem
 * öffentlichen Teil des ABSENDERS, und der ist genau in dieser Lage weg. Wer
 * sein Gerät verloren hat, hat ein neues Schlüsselpaar — jeder Anteil, der
 * auf das alte rechnet, wäre in dem Augenblick unbrauchbar, in dem er
 * gebraucht wird. Deshalb entsteht je Paket ein Wegwerf-Schlüsselpaar; sein
 * öffentlicher Teil steht hier, sein privater wird nie abgelegt. Die
 * empfangende Seite rechnet mit ihrem eigenen, dauerhaften privaten Teil
 * gegen `eph` — sie muss dafür über den Absender gar nichts wissen.
 */
export interface FluechtigesPaket {
  alg: string;
  /** Der öffentliche Teil des Wegwerf-Paares, als JWK-Text. */
  eph: string;
  iv: string;
  daten: string;
}

/**
 * Der Kontoschlüssel, verschlossen mit dem Notschlüssel.
 *
 * `kontoAbdruck` ist der Abdruck des KONTOSCHLÜSSELS — derselbe Wert wie in
 * KontoSchluesselBlob.abdruck. Daran erkennt der Server, dass diese Hülle
 * zum heute gültigen Kontoschlüssel gehört, ohne einen von beiden zu sehen.
 */
export interface NotzugangHuelle {
  alg: string;
  iv: string;
  daten: string;
  kontoAbdruck: string;
  kontoFassung: number;
  schwelle: number;
  anteile: number;
}

/** Ein Anteil, wie er beim Server liegt: verschlossen für eine Person. */
export interface NotzugangAnteilBlob {
  halterId: string;
  /** Die x-Stelle im Körper (1…5) — steht offen, sie ist kein Geheimnis. */
  stelle: number;
  /** Abdruck des öffentlichen Teils, für den verpackt wurde. Wechselt das
   *  Schlüsselpaar der haltenden Person, passt der Anteil nicht mehr — und
   *  DAS soll auffallen, statt still die Schwelle zu senken. */
  halterAbdruck: string;
  paket: FluechtigesPaket;
}

/** Was eine haltende Person zu einer Anfrage beisteuert. */
export interface NotzugangBeitragBlob {
  anfrageId: string;
  /** Doppelt verschlossen: innen für die anfragende Person, außen mit dem
   *  Code (siehe NOTZUGANG_CODE_RUNDEN). */
  paket: FluechtigesPaket;
  codeAbdruck: string;
}

/**
 * Runden für die Ableitung aus dem Wiederherstellungscode.
 *
 * Dieselbe Zahl wie bei den Freigabecodes in lib/vertraulich.ts, und aus
 * demselben Grund dieselbe Codeform wie beim Wiederherstellungscode (sechs
 * Vierergruppen, siehe WIEDERHERSTELLUNG_GRUPPEN): dieser Code steht vor dem
 * Kontoschlüssel, nicht vor einem einzelnen Kanal für ein paar Tage. Ein
 * sechsstelliger Code wäre für einen Angreifer mit der Datenbank in der Hand
 * durchprobierbar; 31^24 ist es nicht.
 */
export const NOTZUGANG_CODE_RUNDEN = 310_000;

/** Wie lange eine Wiederherstellungsanfrage offen steht. Kurz, weil in
 *  dieser Zeit drei Menschen zusammen etwas aufschließen können. */
export const NOTZUGANG_ANFRAGE_STUNDEN = 24;

/** Was die Oberfläche über einen Notzugang wissen muss — ohne ein Geheimnis. */
export interface NotzugangHalterStand {
  halterId: string;
  stelle: number;
  /** Ist das Konto der haltenden Person noch aktiv? */
  aktiv: boolean;
  /** Passt ihr heutiger öffentlicher Teil noch zu dem, für den verpackt
   *  wurde? Nein heißt: dieser Anteil zählt nicht mehr mit. */
  schluesselPasst: boolean;
}

export interface NotzugangStand {
  eingerichtet: boolean;
  schwelle: number;
  anteile: number;
  /** Wie viele Anteile heute wirklich noch einlösbar wären. Sinkt diese Zahl
   *  unter die Schwelle, ist der Notzugang kaputt — und sagt es. */
  brauchbar: number;
  halter: NotzugangHalterStand[];
  erstelltAm: number;
  /**
   * Wie viele der haltenden Personen HEUTE in der Verwaltung sitzen (owner
   * oder admin).
   *
   * Beim Einrichten wird das geprüft und begrenzt (services/notzugang.ts,
   * einrichten()) — aber eine Beförderung danach fragt niemanden. Zwei
   * Beförderungen später halten drei Verwaltende drei Anteile, und das ist
   * genau die Aufstellung, die die Regel verbietet. Die Zahl wird deshalb
   * bei JEDER Auskunft neu gemessen statt beim Einrichten eingefroren.
   */
  ausDerVerwaltung: number;
  /** `ausDerVerwaltung >= schwelle`: der Kreis, der ohnehin Passwörter
   *  zurücksetzt, erreicht die Schwelle allein. Die Tafel sagt das. */
  verwaltungZuViele: boolean;
  /**
   * Wartet für DIESES Konto gerade eine Wiederherstellung — dieselbe
   * Tatsache wie bei `notzugangWartet` in NotzugangHinweis.tsx, nur diesmal
   * für die eigene Tafel und nicht für den Streifen darüber.
   *
   * Kommt vom Server als `kontoschluessel.notzugangWartet(userId)` (siehe
   * dort für die ausführliche Begründung) und wird hier NICHT ein zweites
   * Mal ausgerechnet — genau das lief einmal auseinander, an genau dieser
   * Stelle. Der Grund, warum es dieses Feld überhaupt braucht: in diesem
   * Zustand öffnet `notzugang.aufheben()` nichts mehr, was noch zu retten
   * wäre — der Kontoschlüssel selbst lebt nur noch HINTER der Hülle des
   * Notzugangs, und "Notzugang aufheben" holt das harte Verwerfen
   * (services/notzugang.ts, aufheben()) in genau diesem Zustand sofort
   * nach, mit einem einzigen Klick. Die Tafel braucht das Feld, um GENAU
   * dann eine ausdrückliche Rückfrage zu stellen (NotzugangPanel.tsx) statt
   * immer oder nie.
   */
  notzugangWartet: boolean;
}

/** Eine laufende Wiederherstellung, wie die Oberfläche sie sieht. */
export interface NotzugangAnfrage {
  id: string;
  userId: string;
  stand: string;
  laeuftAb: number;
  erstelltAm: number;
  /** Wie viele Beiträge eingegangen sind. Eine Bequemlichkeit für die
   *  Anzeige — durchgesetzt wird die Schwelle von der Rechnung, nicht von
   *  dieser Zahl. */
  beitraege: number;
}

/** Was auf eine haltende Person wartet — samt ihrem verschlossenen Anteil. */
export interface NotzugangAufgabe {
  anfrageId: string;
  /** Wessen Zugang wiederhergestellt werden soll. */
  userId: string;
  stelle: number;
  erstelltAm: number;
  laeuftAb: number;
  erledigt: boolean;
  anteil: FluechtigesPaket;
}

/** Eine Zeile der Spur. Trägt nie ein Geheimnis, nur Kennungen und Zeiten. */
export interface NotzugangProtokollZeile {
  id: string;
  art: string;
  halterId: string | null;
  anfrageId: string | null;
  am: number;
}
