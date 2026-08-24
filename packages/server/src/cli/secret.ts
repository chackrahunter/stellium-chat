import path from 'node:path';
import fs from 'node:fs';
import readline from 'node:readline';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { Writable } from 'node:stream';
import {
  Vault, deleteKeychain, keychainAvailable, readKeychain,
  resolvePassphrase, writeKeychain,
} from '../secrets.js';

/**
 * Verwaltung der verschlüsselten Schlüssel.
 *
 *   npm run secret -w @stellium/server -- setzen groq
 *   npm run secret -w @stellium/server -- liste
 *   npm run secret -w @stellium/server -- entfernen groq
 *   npm run secret -w @stellium/server -- passwort-neu
 */

/* ── Wo die Daten liegen ──────────────────────────────────────────
 *
 * MASSGEBEND IST config.ts. Was hier steht, ist eine Abschrift.
 *
 * config.ts rechnet die Vorgabe gegen das PAKETVERZEICHNIS, und der Kommentar
 * dort sagt auch, warum: vorher entschied das Arbeitsverzeichnis darüber, wo
 * Datenbank und Tresor liegen — aus dem Projektwurzelverzeichnis gestartet fand
 * der Server einen anderen Datenbestand als aus packages/server heraus.
 *
 * Dieses Werkzeug hat jene Korrektur nie bekommen und rechnete weiter gegen
 * process.cwd(). Über `npm run secret -w @stellium/server` fällt das nicht auf:
 * npm setzt das Arbeitsverzeichnis auf packages/server, und beide Rechnungen
 * kommen zufällig auf dasselbe Verzeichnis. Aus dem Projektwurzelverzeichnis
 * heraus aufgerufen legte der Befehl den Schlüssel dagegen in
 * <projekt>/data/secrets.enc, während der Server
 * <projekt>/packages/server/data/secrets.enc liest — ohne Fehlermeldung. Der
 * Schlüssel war abgelegt, der Server sah ihn nie, und nichts sagte warum.
 *
 * WARUM ABGESCHRIEBEN UND NICHT IMPORTIERT
 * config.ts arbeitet bereits beim Import: es legt Verzeichnisse an, erzeugt und
 * schreibt data/.jwt-secret und data/.vapid-keys.json, öffnet den Tresor und
 * fragt dafür die Keychain. Ein Werkzeug, das vielleicht nur seine Hilfe
 * ausgeben soll, darf das nicht auslösen — und schon gar nicht, bevor die
 * Prüfung unten überhaupt sagen konnte, dass hier zwei Orte im Spiel sind.
 * Also steht die Regel zweimal da. Wer sie in config.ts ändert, muss sie hier
 * mitändern; zwei Abschriften waren der Ursprung dieses Fehlers.
 *
 * Diese Datei liegt in src/cli/ beziehungsweise dist/cli/ — das Paket ist zwei
 * Ebenen darüber. (config.ts liegt eine Ebene höher und braucht dort nur ein
 * '..'.)
 */
const paketWurzel = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

/* Wortgleich zu ordner() in config.ts: ein ausdrücklich gesetzter Pfad gilt
   relativ zum Arbeitsverzeichnis — wer ihn angibt, meint das, was er gerade vor
   sich hat. Die Vorgabe dagegen hängt am Paket und bleibt überall dieselbe.
   Auch das Abschneiden der Leerzeichen gehört dazu: ein leer gesetztes DATA_DIR
   ist keine Angabe, sondern eine vergessene Zeile in der .env. */
const gesetzterOrdner = (process.env.DATA_DIR ?? '').trim();
const dataDir = gesetzterOrdner
  ? path.resolve(process.cwd(), gesetzterOrdner)
  : path.resolve(paketWurzel, 'data');

const tresorDatei = path.join(dataDir, 'secrets.enc');
const vault = new Vault(tresorDatei);

/** Wohin dieselbe Zeile vor der Korrektur zeigte — Zeichen für Zeichen. */
const alterTresor = path.join(
  path.resolve(process.cwd(), process.env.DATA_DIR ?? './data'),
  'secrets.enc',
);

/**
 * Der gefährliche Teil der Korrektur.
 *
 * Sie verschiebt nicht nur, wohin geschrieben wird, sondern auch, wo ein
 * VORHANDENER Tresor gesucht wird. Wer diesen Befehl bisher aus dem
 * Projektwurzelverzeichnis aufgerufen hat, hat dort einen echten Tresor liegen.
 * Ab dieser Version schaut der Befehl woanders hin — und ohne diese Prüfung
 * sähe das aus, als wäre nie ein Tresor da gewesen. Der nächste Schritt wäre,
 * die Schlüssel neu einzutippen; die alte Datei bliebe unbemerkt liegen, und
 * wer sie später findet, weiß nicht mehr, welche der beiden gilt.
 *
 * Hier wird deshalb nichts geraten, nichts verschoben und nichts kopiert. In
 * der Datei stehen API-Schlüssel; wohin die gehören, entscheidet der Betreiber,
 * und ein falsch geratener Ort kostet sie.
 *
 * Läuft vor JEDEM Befehl, auch vor keychain-loeschen: gerade wer in dieser Lage
 * das Masterpasswort aus der Keychain wirft, verliert den Zugang zu einem
 * Tresor, den er noch gar nicht gefunden hat.
 */
function tresorOrtPruefen(): void {
  /* Beide Rechnungen kommen auf dieselbe Datei — dann gibt es nichts zu
     erklären. Das ist der Normalfall über `npm run secret -w @stellium/server`
     und bei absolut gesetztem DATA_DIR. Kein Wort darüber, damit die Warnung
     unten es bleibt: eine Warnung. */
  if (alterTresor === tresorDatei) return;

  const neuDa = fs.existsSync(tresorDatei);
  const altDa = fs.existsSync(alterTresor);

  if (!altDa) {
    /* Nichts zu retten. Trotzdem einmal sagen, welche Datei gemeint ist: das
       Arbeitsverzeichnis weicht ab, und genau dieses Missverständnis soll hier
       nicht ein zweites Mal entstehen. */
    console.log(`Tresor: ${tresorDatei}${neuDa ? '' : '  (noch nicht angelegt)'}`);
    return;
  }

  if (neuDa) {
    /* Beide da. Benutzt wird der Ort, den auch der Server liest — alles andere
       wäre wieder eine stille Entscheidung. Aber ungesagt bleibt es nicht: die
       zweite Datei kann Schlüssel enthalten, die hier fehlen. */
    console.warn(
      '\n[!] Es gibt zwei Tresordateien.\n'
      + `      benutzt wird:   ${tresorDatei}\n`
      + `      liegt daneben:  ${alterTresor}\n`
      + '\n'
      + '    Der Server liest ausschließlich die erste — sie hängt am Serverpaket,\n'
      + '    nicht am Arbeitsverzeichnis. Die zweite stammt aus einem Aufruf dieses\n'
      + '    Befehls aus einem anderen Verzeichnis. Sie wird hier weder gelesen noch\n'
      + '    geändert, und was darin steht, erreicht den Server nie.\n'
      + '\n'
      + '    Sieh nach, ob dort Schlüssel liegen, die hier fehlen — und räum sie\n'
      + '    danach weg, damit nicht später jemand die falsche Datei pflegt:\n'
      + `      DATA_DIR='${path.dirname(alterTresor)}' npm run secret -w @stellium/server -- liste\n`,
    );
    return;
  }

  throw new Error(
    'Der Tresor liegt nicht dort, wo dieser Befehl — und der Server — ihn erwarten.\n'
    + '\n'
    + `  erwartet:  ${tresorDatei}\n`
    + '             ^ diese Datei liest der Server, und nur diese\n'
    + `  gefunden:  ${alterTresor}\n`
    + '\n'
    + '  WARUM\n'
    + '  Der Ort der Daten hängt am Serverpaket, nicht am Arbeitsverzeichnis — sonst\n'
    + '  hätte der Server je nach Startverzeichnis einen anderen Datenbestand. Dieses\n'
    + '  Werkzeug hat sich bis eben nicht daran gehalten und den Tresor dorthin\n'
    + '  geschrieben, wo es gerade gestartet wurde. Die gefundene Datei stammt aus so\n'
    + '  einem Aufruf. Verloren ist nichts — sie liegt noch genau dort.\n'
    + '\n'
    + '  WAS ZU TUN IST\n'
    + '  Von Hand, mit Blick auf beide Verzeichnisse. Verschoben wird hier nichts\n'
    + '  von selbst: in der Datei stehen API-Schlüssel, und ein falsch geratener\n'
    + '  Ort verliert sie.\n'
    + '\n'
    + `    mkdir -p '${dataDir}'\n`
    + `    mv '${alterTresor}' '${tresorDatei}'\n`
    + '\n'
    + '  Oder, falls die Daten wirklich dort liegen sollen, wo sie liegen: DATA_DIR\n'
    + '  auf jenes Verzeichnis setzen — dann aber für den Server GENAUSO, sonst geht\n'
    + '  das Auseinanderlaufen von vorn los:\n'
    + `    DATA_DIR=${path.dirname(alterTresor)}\n`
    + '\n'
    + '  Sieh vorher hin: im alten Verzeichnis kann mehr liegen (stellium.db,\n'
    + '  .jwt-secret, uploads/). Das kann ein zweiter, älterer Datenbestand aus\n'
    + '  derselben Verwechslung sein. Bewege erst diese eine Datei, nicht alles.',
  );
}

/**
 * Eingabe ohne Anzeige auf dem Bildschirm.
 * Kommt die Eingabe aus einer Pipe (kein Terminal), wird sie direkt gelesen —
 * so lässt sich der Befehl auch in Skripten und Tests verwenden.
 */
function askHidden(frage: string): Promise<string> {
  if (!process.stdin.isTTY) {
    return new Promise((resolve) => {
      let puffer = '';
      process.stdin.setEncoding('utf8');
      process.stdin.on('data', (d) => { puffer += d; });
      process.stdin.on('end', () => resolve(puffer.split('\n')[0].trim()));
    });
  }
  return new Promise((resolve) => {
    const stumm = new Writable({
      write(chunk, _enc, cb) {
        // Nur die Frage durchlassen, die Eingabe selbst nicht spiegeln.
        if (!(stumm as any).muted) process.stdout.write(chunk);
        cb();
      },
    });
    const rl = readline.createInterface({ input: process.stdin, output: stumm, terminal: true });
    process.stdout.write(frage);
    (stumm as any).muted = true;
    rl.question('', (answer) => {
      (stumm as any).muted = false;
      process.stdout.write('\n');
      rl.close();
      resolve(answer);
    });
  });
}

function ask(frage: string): Promise<string> {
  if (!process.stdin.isTTY) return Promise.resolve('j');   // Vorgabe in Skripten
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve) => rl.question(frage, (a) => { rl.close(); resolve(a.trim()); }));
}

/**
 * Bestätigung, die man nicht aus Versehen gibt: der Satz muss Zeichen für
 * Zeichen abgetippt werden.
 *
 * Bewusst NICHT über ask() — das antwortet ohne Terminal von sich aus mit "j",
 * damit Skripte durchlaufen. Für eine Rückfrage, hinter der Datenverlust
 * steht, wäre genau das die falsche Vorgabe: ein Skript würde die Warnung
 * stillschweigend wegklicken. Ohne Terminal gibt es hier deshalb keine
 * Zustimmung, sondern einen Abbruch.
 */
async function bestaetigeGenau(satz: string): Promise<void> {
  if (!process.stdin.isTTY) {
    throw new Error(
      'Das braucht eine ausdrückliche Bestätigung an einem Terminal.\n'
      + '  Über eine Pipe oder aus einem Skript heraus geht dieser Befehl nicht.',
    );
  }
  const antwort = await ask(`\nZum Fortfahren tippe genau  ${satz}\n> `);
  if (antwort !== satz) throw new Error('Abgebrochen — nichts geändert.');
}

/* ── Stärke des Masterpassworts ───────────────────────────────────
 *
 * DIE ANNAHME, AUF DER HIER ALLES STEHT
 * Aus diesem einen Passwort entstehen vier Schlüssel:
 *
 *   crypto/pii.ts          feld  (E-Mail, Benutzername) und index (handle_bidx,
 *                          email_bidx — darüber läuft die ANMELDUNG)
 *   crypto/nachrichten.ts  text  (jeder Nachrichtentext) und suche (Volltextindex)
 *
 * Alle vier werden mit HKDF abgeleitet, und das ist richtig so: HKDF ist ein
 * Schlüsselableiter, kein Passworthasher. Es läuft bei jedem Start, es muss
 * schnell sein, und es hat deshalb KEINEN Arbeitsfaktor — kein scrypt, kein
 * Argon2, nichts, was einen einzelnen Rateversuch teuer macht.
 *
 * Das ist nur dann in Ordnung, wenn das Passwort selbst schon Zufall in
 * voller Schlüssellänge mitbringt. Genau diese Annahme stand nirgends
 * geschrieben, und geprüft wurde sie mit "mindestens 12 Zeichen". Wer damit
 * ein gewachsenes 240-Bit-Passwort durch etwas Merkbares ersetzt, macht in
 * dem Moment jede Nachricht, jeden Namen und jede Adresse in der Datenbank
 * mit Grafikkartentempo knackbar — ohne dass irgendetwas kaputt aussieht.
 *
 * Der Tresor secrets.enc ist der andere Fall und darf nicht als Vorbild
 * dienen: der geht über scrypt (N=2^17, siehe secrets.ts) und bringt seinen
 * Widerstand selbst mit. Die Datenbank tut das nicht.
 *
 * WAS DIESE PRÜFUNG IST UND WAS NICHT
 * Eine Schätzung, absichtlich zu niedrig geraten statt zu hoch: erkannte
 * Muster (Wörter, Folgen, Tastaturreihen, Wiederholungen) werden mit dem
 * bewertet, was sie einen Angreifer kosten, nicht mit ihrer Länge. Sie ist
 * eine Bremse gegen Unachtsamkeit, kein Beweis für Stärke — ein Beweis wäre
 * nur "vom Zufallsgenerator erzeugt", und genau das ist deshalb der
 * vorgeschlagene Weg.
 */

/** Ab hier gilt ein Passwort als tragfähig. */
const MINDEST_BITS = 100;

/**
 * Und zusätzlich diese Länge. Unterhalb davon kann die Schätzung Zufall und
 * geschickt gebautes Muster nicht mehr sauber auseinanderhalten, und der
 * Spielraum kostet nichts: erzeugte Passwörter sind ohnehin doppelt so lang.
 */
const MINDEST_LAENGE = 20;

/** Der ausdrückliche Umweg, falls jemand es wirklich besser weiß. */
const UEBERGEHEN = 'ja-ich-weiss-was-ich-tue';

const WOERTER = [
  // Deutsch, alltäglich
  'passwort', 'kennwort', 'geheim', 'sommer', 'winter', 'fruehling', 'frühling', 'herbst',
  'januar', 'februar', 'maerz', 'märz', 'april', 'juni', 'juli', 'august', 'september',
  'oktober', 'november', 'dezember', 'montag', 'dienstag', 'mittwoch', 'donnerstag',
  'freitag', 'samstag', 'sonntag', 'liebe', 'lieben', 'hallo', 'guten', 'morgen', 'abend',
  'danke', 'bitte', 'wasser', 'feuer', 'himmel', 'sonne', 'mond', 'stern', 'sterne',
  'blume', 'baum', 'wald', 'berg', 'meer', 'haus', 'wohnung', 'garten', 'auto', 'fahrrad',
  'katze', 'hund', 'pferd', 'vogel', 'maus', 'schule', 'arbeit', 'firma', 'buero', 'büro',
  'chef', 'kollege', 'freund', 'familie', 'mutter', 'vater', 'kind', 'kinder', 'bruder',
  'schwester', 'name', 'stadt', 'land', 'strasse', 'straße', 'deutschland',
  'berlin', 'hamburg', 'muenchen', 'münchen', 'koeln', 'köln', 'frankfurt', 'stuttgart',
  'bayern', 'schalke', 'dortmund', 'fussball', 'fußball', 'bier', 'wein', 'kaffee',
  'schokolade', 'urlaub', 'ferien', 'weihnachten', 'ostern', 'geburtstag', 'zusammen',
  'immer', 'niemals', 'wieder', 'schoen', 'schön', 'gross', 'groß', 'klein', 'schnell',
  'langsam', 'stark', 'sicher', 'geheimnis', 'schluessel', 'schlüssel', 'tresor',

  // Englisch, alltäglich
  'password', 'secret', 'admin', 'administrator', 'root', 'login', 'user', 'username',
  'welcome', 'hello', 'world', 'summer', 'spring', 'autumn', 'monday', 'friday',
  'january', 'december', 'love', 'lover', 'iloveyou', 'money', 'dragon', 'monkey',
  'master', 'shadow', 'sunshine', 'princess', 'football', 'baseball', 'soccer', 'hockey',
  'computer', 'internet', 'server', 'system', 'default', 'change', 'changeme', 'letmein',
  'trustno', 'access', 'freedom', 'whatever', 'batman', 'superman', 'starwars', 'pokemon',
  'correct', 'horse', 'battery', 'staple', 'coffee', 'orange', 'purple', 'yellow',
  'flower', 'garden', 'house', 'mountain', 'river', 'ocean', 'forest',
  'family', 'mother', 'father', 'brother', 'sister', 'friend', 'school', 'office',
  'company', 'holiday', 'birthday', 'christmas', 'happy', 'lucky', 'magic', 'silver',
  'golden', 'diamond', 'phoenix', 'thunder', 'storm', 'night', 'light', 'dark',
  'green', 'black', 'white', 'blue', 'never', 'always', 'forever', 'together',
  'please', 'thanks', 'water', 'fire', 'earth', 'wind', 'moon', 'star',

  // Was hier im Haus naheliegt und deshalb zuerst probiert würde
  'stellium', 'alaska', 'raspberry', 'chat', 'team', 'groq', 'openai', 'deepl',
  'anchorage', 'fairbanks', 'juneau', 'nordlicht', 'polarlicht',

  // Klassische Fehlgriffe
  'qwertz', 'qwerty', 'asdf', 'yxcv', 'zxcv', 'test', 'temp', 'demo', 'dummy',
  'foobar', 'null', 'none', 'nope',
];

/** Lang zuerst, damit das längste passende Wort gewinnt. */
const WORTLISTE = [...new Set(WOERTER.map((w) => w.toLowerCase()))]
  .filter((w) => w.length >= 4)
  .sort((a, b) => b.length - a.length);

const REIHEN = ['1234567890', 'qwertzuiop', 'qwertyuiop', 'asdfghjklöä', 'asdfghjkl', 'yxcvbnm', 'zxcvbnm'];

/** Zahlendreher, mit denen ein Wort gern "sicher" gemacht wird. */
const LEET: Record<string, string> = {
  '@': 'a', '4': 'a', '3': 'e', '1': 'i', '!': 'i', '0': 'o', '5': 's', '$': 's', '7': 't', '8': 'b',
};

const VOKALE = 'aeiouyäöü';
const ld = (n: number): number => Math.log2(Math.max(n, 1));

function entleeten(text: string): string {
  return [...text.toLowerCase()].map((c) => LEET[c] ?? c).join('');
}

/**
 * Wie viele Zeichen kämen überhaupt in Frage? Wer nur Kleinbuchstaben nimmt,
 * verschenkt je Zeichen mehr als ein Bit gegenüber gemischter Schreibweise.
 */
function zeichenvorrat(text: string): number {
  let pool = 0;
  if (/[a-z]/.test(text)) pool += 26;
  if (/[A-Z]/.test(text)) pool += 26;
  if (/[0-9]/.test(text)) pool += 10;
  if (/[^a-zA-Z0-9]/.test(text)) pool += 33;
  if (/[^\x00-\x7f]/.test(text)) pool += 100;
  return Math.max(pool, 2);
}

/** Wie weit lässt sich ab hier eine Tastaturreihe entlanglaufen? */
function reihenLauf(text: string, i: number): number {
  const klein = text.toLowerCase();
  let best = 0;
  for (const reihe of REIHEN) {
    for (const richtung of [1, -1]) {
      let pos = reihe.indexOf(klein[i]);
      if (pos < 0) continue;
      let laenge = 1;
      while (i + laenge < klein.length) {
        const naechste = pos + richtung;
        if (naechste < 0 || naechste >= reihe.length || reihe[naechste] !== klein[i + laenge]) break;
        pos = naechste;
        laenge += 1;
      }
      best = Math.max(best, laenge);
    }
  }
  return best;
}

/** Auf- oder absteigend im Zeichensatz: abc, 789, zyx. */
function folgenLauf(text: string, i: number): number {
  let best = 0;
  for (const schritt of [1, -1]) {
    let laenge = 1;
    while (i + laenge < text.length
      && text.charCodeAt(i + laenge) === text.charCodeAt(i + laenge - 1) + schritt) laenge += 1;
    best = Math.max(best, laenge);
  }
  return best;
}

/**
 * Sieht das Stück nach einer sprechbaren Silbe aus statt nach Zufall?
 *
 * Fängt die Bauart "wort-wort-wort" ab, auch wenn die Wörter selbst nicht in
 * der Liste oben stehen: sechs sprechbare Silben aus einer Wörterliste sind
 * rund 78 Bit, nicht 200 — die Länge täuscht hier gewaltig.
 */
function sprechbar(stueck: string): boolean {
  if (stueck.length < 3 || stueck.length > 12) return false;
  const anteil = [...stueck].filter((c) => VOKALE.includes(c)).length / stueck.length;
  if (anteil < 0.2 || anteil > 0.65) return false;
  return !/[^aeiouyäöü]{5}/.test(stueck);
}

type Fund = 'wort' | 'wortartig' | 'wiederholung' | 'folge' | 'tastatur' | 'jahr' | 'ziffern' | 'trennzeichen';

/**
 * Das Passwort von links nach rechts in Stücke zerlegen und jedes Stück mit
 * dem bewerten, was es kostet, es zu erraten. Ein erkanntes Muster kostet den
 * Griff in eine kurze Liste, ein unerklärliches Zeichen den vollen Vorrat.
 */
function entropieSchaetzung(text: string): { bits: number; funde: Fund[] } {
  const proZeichen = ld(zeichenvorrat(text));
  const flach = entleeten(text);
  const funde = new Set<Fund>();
  let bits = 0;
  let i = 0;

  while (i < text.length) {
    let laenge = 1;
    let kosten = proZeichen;

    // Wörterbuch — auch quer durch Zahlendreher hindurch (P4ssw0rt).
    for (const wort of WORTLISTE) {
      if (wort.length > text.length - i) continue;
      if (flach.startsWith(wort, i)) {
        if (wort.length > laenge) {
          laenge = wort.length;
          kosten = ld(WORTLISTE.length) + 1 + 1;      // Liste + Groß/klein + Leet
          funde.add('wort');
        }
        break;
      }
    }

    // Dasselbe Zeichen mehrfach hintereinander.
    let gleich = 1;
    while (i + gleich < text.length && text[i + gleich] === text[i]) gleich += 1;
    if (gleich >= 3 && gleich > laenge) {
      laenge = gleich; kosten = proZeichen + ld(gleich); funde.add('wiederholung');
    }

    const folge = folgenLauf(text, i);
    if (folge >= 3 && folge > laenge) {
      laenge = folge; kosten = proZeichen + ld(folge) + 1; funde.add('folge');
    }

    const reihe = reihenLauf(text, i);
    if (reihe >= 3 && reihe > laenge) {
      laenge = reihe; kosten = proZeichen + ld(reihe) + 1; funde.add('tastatur');
    }

    // Jahreszahl — vierstellig, aber nur zweihundert Möglichkeiten.
    if (/^(19|20)\d\d$/.test(text.slice(i, i + 4)) && laenge < 4) {
      laenge = 4; kosten = ld(200); funde.add('jahr');
    }

    // Ein Stück, das weiter vorn schon einmal stand.
    for (let l = Math.min(12, text.length - i); l > laenge && l >= 3; l -= 1) {
      if (text.slice(0, i).includes(text.slice(i, i + l))) {
        laenge = l; kosten = ld(i) + ld(l); funde.add('wiederholung'); break;
      }
    }

    // Ziffernblock — Ziffern kommen aus zehn Möglichkeiten, nicht aus dem
    // ganzen Vorrat. Sonst zählte "2026" so viel wie vier zufällige Zeichen.
    if (laenge === 1 && /[0-9]/.test(text[i])) {
      let z = 1;
      while (i + z < text.length && /[0-9]/.test(text[i + z])) z += 1;
      if (z >= 2) { laenge = z; kosten = z * ld(10); funde.add('ziffern'); }
    }

    // Sprechbare Silbe zwischen Trennzeichen.
    if (i === 0 || /[^a-zA-Z0-9]/.test(text[i - 1])) {
      const stueck = /^[a-zäöüß]+/.exec(text.slice(i))?.[0] ?? '';
      const endetSauber = stueck.length > 0
        && (i + stueck.length === text.length || /[^a-zA-Z0-9]/.test(text[i + stueck.length]));
      if (endetSauber && stueck.length > laenge && sprechbar(stueck)) {
        laenge = stueck.length; kosten = ld(10_000); funde.add('wortartig');
      }
    }

    // Immer dasselbe Trennzeichen trägt nach dem ersten Mal fast nichts mehr
    // bei — wer "-" einmal gesehen hat, rät es beim zweiten Mal nicht neu.
    if (laenge === 1 && /[^a-zA-Z0-9]/.test(text[i]) && text.slice(0, i).includes(text[i])) {
      kosten = 2; funde.add('trennzeichen');
    }

    bits += kosten;
    i += laenge;
  }

  return { bits, funde: [...funde] };
}

/**
 * Warum es durchgefallen ist — in Kategorien, nie im Wortlaut.
 *
 * Das abgelehnte Passwort steht bewusst NICHT in der Meldung, auch nicht in
 * Bruchstücken: die Ausgabe landet im SSH-Rückblick und womöglich im
 * journald, und wer eben "Sommer2026!" abgelehnt bekam, tippt als Nächstes
 * "Sommer2027!". Ein Bruchstück in der Mitschrift wäre dann ein Hinweis auf
 * das Passwort, das danach wirklich benutzt wurde.
 */
const FUND_TEXT: Record<Fund, string> = {
  wort: 'ein Wort, das in jeder Rateliste steht',
  wortartig: 'sprechbare Silben — die stammen aus Wortlisten, nicht aus Zufall',
  wiederholung: 'ein Stück, das sich im Passwort wiederholt',
  folge: 'eine fortlaufende Reihe (abc, 123, zyx)',
  tastatur: 'eine Tastaturreihe (qwertz, asdf)',
  jahr: 'eine Jahreszahl — davon gibt es zweihundert',
  ziffern: 'ein Ziffernblock',
  trennzeichen: 'immer dasselbe Trennzeichen',
};

function schwachesPasswortErlaubt(): boolean {
  return (process.env.STELLIUM_SCHWACHES_MASTERPASSWORT ?? '').trim().toLowerCase() === UEBERGEHEN;
}

/**
 * Prüft ein von Hand eingegebenes Passwort und wirft, wenn es nicht trägt.
 * Der erzeugte Weg geht hier nicht durch — der braucht keine Prüfung.
 */
function passwortPruefen(eingabe: string): void {
  const { bits, funde } = entropieSchaetzung(eingabe);
  const zuKurz = eingabe.length < MINDEST_LAENGE;
  if (!zuKurz && bits >= MINDEST_BITS) return;

  if (schwachesPasswortErlaubt()) {
    console.warn(
      `\n[!] Schwaches Masterpasswort ausdrücklich zugelassen (rund ${Math.round(bits)} Bit statt ${MINDEST_BITS}).\n`
      + '    Nachrichten, Namen und Adressen in der Datenbank sind ab jetzt nur noch\n'
      + '    so gut geschützt wie dieses Passwort. Es gibt keinen Arbeitsfaktor, der\n'
      + '    das abfedert.\n',
    );
    return;
  }

  const gruende = funde.length
    ? funde.map((f) => `    - ${FUND_TEXT[f]}`).join('\n')
    : '    - zu wenig Zeichen für die nötige Stärke';

  throw new Error(
    `Dieses Masterpasswort trägt nicht: geschätzt rund ${Math.round(bits)} Bit, gebraucht werden ${MINDEST_BITS}.`
    /* Die genaue Länge der Eingabe steht bewusst nicht dabei — aus demselben
       Grund, aus dem auch kein Bruchstück dasteht (siehe FUND_TEXT). */
    + (zuKurz ? `\n(Und mindestens ${MINDEST_LAENGE} Zeichen sind es auch nicht.)` : '')
    + `\n\n  Was dagegen spricht:\n${gruende}\n`
    + '\n  WARUM HIER STRENGER GEMESSEN WIRD ALS ANDERSWO'
    + '\n  Aus diesem Passwort entstehen vier Schlüssel: Nachrichtentexte, Volltext-'
    + '\n  index, Personendaten und der Blind-Index, über den die ANMELDUNG läuft.'
    + '\n  Abgeleitet wird mit HKDF, und HKDF hat keinen Arbeitsfaktor — kein scrypt,'
    + '\n  kein Argon2, nichts, was einen Rateversuch teuer macht. Wer die Datei'
    + '\n  data/stellium.db in die Hand bekommt, kann Passwörter so schnell'
    + '\n  durchprobieren, wie seine Grafikkarte rechnet.'
    + '\n'
    + '\n  Damit ist die Stärke dieses Passworts das Einzige, was die Nachrichten,'
    + '\n  Namen und E-Mail-Adressen aller Beteiligten schützt. Kein Zeitfaktor'
    + '\n  federt eine schlechte Wahl ab, und man merkt den Fehler nie: der Server'
    + '\n  läuft weiter, als wäre alles in Ordnung.'
    + '\n'
    + '\n  (Der Tresor secrets.enc ist der andere Fall — der geht über scrypt und'
    + '\n  bringt seinen Widerstand selbst mit. Die Datenbank tut das nicht.)'
    + '\n'
    + '\n  WAS ZU TUN IST'
    + '\n  Lass das Passwort erzeugen — der Befehl bietet das von sich aus an. Es hat'
    + '\n  dann 256 Bit, und niemand muss es sich merken.'
    + '\n'
    + '\n  Wenn du wirklich weißt, was du tust, und die Folgen tragen willst:'
    + `\n    STELLIUM_SCHWACHES_MASTERPASSWORT=${UEBERGEHEN}`,
  );
}

/* ── Ein neues Passwort ablegen ───────────────────────────────── */

/**
 * Das Passwort in eine Datei legen, die nur dem eigenen Benutzer gehört.
 *
 * Vorher stand ein frisch erzeugtes Masterpasswort mit console.log auf dem
 * Bildschirm. Auf dem Pi gibt es keine Keychain, also war das dort IMMER der
 * Weg — und damit lag der Schlüssel zu allen Nachrichten im SSH-Rückblick,
 * in jedem "script"-Mitschnitt und je nach Aufruf im journald.
 *
 * Die Datei entsteht in einem Zug mit 0600 (O_CREAT|O_EXCL, dritter Parameter
 * von openSync). Nicht erst anlegen und dann chmod: dazwischen läge ein
 * Moment, in dem sie jeder lesen kann. Ein vorhandener Rest wird vorher
 * weggeräumt, und 'wx' scheitert, falls in dem Moment jemand anders etwas an
 * diese Stelle legt — auch ein Symlink.
 */
function passwortInDateiLegen(wert: string): string {
  const datei = path.join(dataDir, 'neues-masterpasswort.txt');
  fs.mkdirSync(dataDir, { recursive: true });
  fs.rmSync(datei, { force: true });
  const fd = fs.openSync(datei, 'wx', 0o600);
  try {
    fs.writeSync(fd, `${wert}\n`, null, 'utf8');
  } finally {
    fs.closeSync(fd);
  }
  return datei;
}

/**
 * Ein starkes Passwort erzeugen und dorthin legen, wo es hingehört. Auf dem
 * Mac in die Keychain, überall sonst in eine Datei — auf keinem der beiden
 * Wege über den Bildschirm.
 */
function passwortErzeugen(): string {
  const erzeugt = crypto.randomBytes(32).toString('base64url');

  if (keychainAvailable()) {
    writeKeychain(erzeugt);
    console.log('\nPasswort erzeugt und in der macOS-Keychain abgelegt.');
    console.log('Es hängt an deinem Benutzerkonto. Ohne deine Anmeldung kommt niemand daran.\n');
    return erzeugt;
  }

  const datei = passwortInDateiLegen(erzeugt);
  console.log('\nPasswort erzeugt — 32 zufällige Bytes.');
  console.log('Es steht mit Absicht nicht hier auf dem Bildschirm, sondern in dieser Datei');
  console.log('(nur für dich lesbar, 0600):');
  console.log(`  ${datei}\n`);
  console.log('So geht es weiter:');
  console.log('  1. Wert als STELLIUM_MASTER_PASSPHRASE in die Umgebung des Dienstes eintragen');
  console.log('     (systemd: EnvironmentFile= — nicht in die .env neben den Daten)');
  console.log('  2. Dienst neu starten');
  console.log('  3. Datei wieder löschen:');
  console.log(`       rm ${datei}\n`);
  console.log('Ohne dieses Passwort ist später nichts in der Datenbank mehr lesbar —');
  console.log('leg es vorher dort ab, wo du Passwörter aufbewahrst.\n');
  return erzeugt;
}

/** Passwort besorgen — vorhandenes benutzen oder ein neues einrichten. */
async function getPassphrase(zumSchreiben: boolean): Promise<string> {
  const vorhanden = resolvePassphrase();
  if (vorhanden) {
    console.log(`Masterpasswort: aus ${vorhanden.source === 'env' ? 'der Umgebungsvariable' : 'der Keychain'}.`);
    return vorhanden.passphrase;
  }

  if (!zumSchreiben) {
    throw new Error(
      'Kein Masterpasswort gefunden.\n'
      + '  Entweder STELLIUM_MASTER_PASSPHRASE setzen\n'
      + '  oder einmal "npm run secret -- setzen <name>" ausführen, das legt es in der Keychain an.',
    );
  }

  console.log('\nEs gibt noch kein Masterpasswort.');
  console.log('Daran hängt nicht nur der Tresor, sondern auch die Datenbank: Nachrichten,');
  console.log('Benutzernamen und E-Mail-Adressen werden damit verschlüsselt.\n');

  /* Erzeugen ist der vorgeschlagene Weg, und zwar auf JEDEM System — nicht
     nur dort, wo es eine Keychain gibt. Vorher war das Angebot an macOS
     gebunden, und ausgerechnet auf dem Pi, wo der Server wirklich läuft, blieb
     nur die Handeingabe übrig. Genau dort entstehen die schwachen Passwörter. */
  const auto = await ask('Soll ich ein starkes Passwort erzeugen? [J/n] ');
  if (auto === '' || /^j/i.test(auto)) return passwortErzeugen();

  const eingabe = await askHidden('Masterpasswort (Eingabe bleibt unsichtbar): ');
  passwortPruefen(eingabe);
  const wiederholung = await askHidden('Zur Sicherheit noch einmal: ');
  if (eingabe !== wiederholung) throw new Error('Die beiden Eingaben stimmen nicht überein.');

  if (keychainAvailable()) {
    const merken = await ask('In der Keychain merken, damit der Server ohne Nachfrage startet? [J/n] ');
    if (merken === '' || /^j/i.test(merken)) writeKeychain(eingabe);
  } else {
    console.log('\nMerke dir das Passwort. Der Server braucht es als STELLIUM_MASTER_PASSPHRASE.');
  }
  return eingabe;
}

/**
 * Was ein Passwortwechsel wirklich anrichtet — vor dem ersten Schreibzugriff.
 *
 * Der Befehl verschlüsselt NUR secrets.enc neu. Die Datenbank rührt er nicht
 * an, und das kann er auch nicht nebenbei: dafür müsste jede Zeile in users,
 * messages und den Indextabellen einzeln mit dem alten Schlüssel gelesen und
 * mit dem neuen geschrieben werden. Bisher stand davon kein Wort in der
 * Ausgabe — man sah nur "Tresor neu verschlüsselt" und hielt es für erledigt.
 */
const WECHSEL_SATZ = 'ALLE KONTEN VERLIEREN';

function wechselWarnung(): void {
  const strich = '━'.repeat(70);
  console.log(`
${strich}
  ACHTUNG — dieser Befehl wechselt das Masterpasswort und rechnet die
  Datenbank NICHT um. Neu verschlüsselt wird allein data/secrets.enc, also
  die API-Schlüssel. Alles andere bleibt unter dem alten Schlüssel liegen.

  Was danach nicht mehr geht:

    Anmelden        handle_bidx und email_bidx passen nicht mehr. NIEMAND
                    kommt mehr in sein Konto — für jeden sieht es aus wie
                    ein falsch eingegebenes Passwort.
    Nachrichten     jeder Text, der mit "m1:" beginnt, bleibt unlesbar.
    Namen, E-Mail   jedes Feld, das mit "v1:" beginnt, bleibt unlesbar.
    Suchen          der Volltextindex wird beim Start neu aufgebaut, findet
                    aber nichts mehr aus der Zeit davor.
    Übersetzungen   der Übersetzungsspeicher wird beim Start geleert.

  Beim nächsten Start merkt db/schluesselprobe.ts den Wechsel und startet
  gar nicht erst. Das ist Absicht — es rettet nichts, es verhindert nur,
  dass ab da neue Daten unter dem neuen Schlüssel in dieselbe Datei
  geschrieben werden. Wer trotzdem starten will, setzt
  STELLIUM_SCHLUESSELWECHSEL=ja; dabei wird NICHTS umgerechnet, die alten
  Konten und Nachrichten bleiben für immer unlesbar.

  Zurück führt nur das ALTE Passwort. Wirf es nicht weg, bevor du sicher
  bist, dass alles läuft.

  Sinnvoll ist dieser Befehl auf einer frischen Installation — oder wenn
  der Verlust ausdrücklich gewollt ist.
${strich}`);
}

async function main(): Promise<void> {
  const [befehl, name] = process.argv.slice(2);

  /* Vor allem anderen: liegt der Tresor dort, wo dieser Befehl ihn sucht?
     Bewusst vor dem switch und ohne Ausnahme — kein Befehl soll an einer Datei
     vorbeiarbeiten, die der Betreiber noch für die seine hält. */
  tresorOrtPruefen();

  switch (befehl) {
    case 'setzen': {
      if (!name) throw new Error('Welcher Schlüssel? z.B. "setzen groq"');
      const passphrase = await getPassphrase(true);
      const wert = (await askHidden(`Wert für "${name}" (Eingabe bleibt unsichtbar): `)).trim();
      if (!wert) throw new Error('Leerer Wert.');

      const secrets = vault.exists() ? vault.load(passphrase) : {};
      secrets[name] = wert;
      vault.save(secrets, passphrase);

      /*
       * Die Bestätigung sagt, DASS es gestimmt hat — nicht, wie der Wert
       * aussieht.
       *
       * Hier stand redact(wert): die ersten vier Zeichen, die letzten zwei und
       * die genaue Länge. Aus genau diesem Grund ist secretOrigin() aus
       * config.ts entfallen (der Kommentar am Ende jener Datei erzählt es) —
       * ein gekürzter Schlüssel ist immer noch ein Schlüssel. Das Präfix nennt
       * bei den meisten Anbietern schon Dienst und Schlüsselart, die Länge
       * macht ihn wiedererkennbar, und beides landet auf derselben
       * Terminalzeile, für deren Schutz zwei Zeilen weiter oben die Eingabe
       * unsichtbar bleibt: im SSH-Rückblick, in jedem script-Mitschnitt,
       * womöglich im journald.
       *
       * Die Frage dahinter ist trotzdem berechtigt — "habe ich mich
       * vertippt?". Beantwortet wird sie über den Weg statt über den Wert: der
       * Tresor wird frisch von der Platte gelesen, entschlüsselt und mit der
       * Eingabe verglichen. Das prüft mehr, als eine Anzeige je könnte
       * (Verschlüsseln, Schreiben, Umbenennen und Entschlüsseln in einem
       * Durchgang), und nach außen dringt davon nur ja oder nein.
       *
       * Auch die reine Zeichenzahl steht bewusst nicht da: sie ist das
       * verlässlichste Erkennungsmerkmal eines Anbieterschlüssels — und beim
       * Vertippen ausgerechnet das, was meistens gleich bleibt.
       *
       * Der zusätzliche scrypt-Durchgang kostet auf dem Pi etwa eine Sekunde.
       * Bei einem Befehl, den man einmal im Jahr tippt, ist das nichts —
       * bitte nicht "wegoptimieren".
       *
       * Vergleich mit ===: beide Werte liegen in diesem Prozess. Wer dessen
       * Laufzeit messen könnte, hätte sie ohnehin schon.
       */
      if (vault.load(passphrase)[name] !== wert) {
        throw new Error(
          'Der Tresor gibt nach dem Schreiben etwas anderes zurück als eingegeben.\n'
          + `  Datei: ${tresorDatei}\n`
          + '  Der Schlüssel ist damit NICHT verlässlich abgelegt. Bitte noch einmal setzen\n'
          + '  und, falls es wieder auftritt, Platz und Rechte des Verzeichnisses prüfen.',
        );
      }

      console.log(`\n"${name}" verschlüsselt abgelegt und zur Probe wieder gelesen — der Inhalt stimmt.`);
      console.log(`Datei: ${tresorDatei}`);
      console.log('\nJetzt kannst du den Schlüssel aus der .env löschen.');
      break;
    }

    case 'liste': {
      const passphrase = await getPassphrase(false);
      if (!vault.exists()) { console.log('Es gibt noch keinen Tresor.'); break; }
      const namen = vault.names(passphrase);
      console.log(namen.length ? `Im Tresor: ${namen.join(', ')}` : 'Der Tresor ist leer.');
      console.log('(Die Werte selbst gibt dieser Befehl bewusst nicht aus.)');
      break;
    }

    case 'entfernen': {
      if (!name) throw new Error('Welcher Schlüssel? z.B. "entfernen groq"');
      const passphrase = await getPassphrase(false);
      const secrets = vault.load(passphrase);
      if (!(name in secrets)) { console.log(`"${name}" ist nicht im Tresor.`); break; }
      delete secrets[name];
      vault.save(secrets, passphrase);
      console.log(`"${name}" entfernt.`);
      break;
    }

    case 'passwort-neu': {
      const altes = resolvePassphrase();
      if (!altes) throw new Error('Kein bisheriges Passwort gefunden.');

      /* Erst lesen, dann warnen, dann schreiben. Das Laden prüft nebenbei, ob
         das alte Passwort überhaupt stimmt — sonst hätte man die Warnung
         umsonst bestätigt. Geschrieben wird bis hierher nichts. */
      const secrets = vault.load(altes.passphrase);

      wechselWarnung();
      await bestaetigeGenau(WECHSEL_SATZ);

      const neues = crypto.randomBytes(32).toString('base64url');

      /*
       * Reihenfolge: erst das neue Passwort sichern, dann den Tresor damit
       * umschlüsseln.
       *
       * Solange der Wert noch auf dem Bildschirm stand, war das egal — man
       * konnte ihn zur Not abschreiben. Jetzt nicht mehr: schlüge das Ablegen
       * NACH dem Umschlüsseln fehl (volle Platte, verweigerte Keychain), wäre
       * der Tresor mit einem Passwort verschlossen, das niemand mehr kennt.
       * Andersherum ist jeder Fehlschlag harmlos — der Tresor liegt dann noch
       * unter dem alten Passwort, das weiter gilt.
       */
      let datei: string | null = null;
      if (keychainAvailable()) writeKeychain(neues);
      else datei = passwortInDateiLegen(neues);

      try {
        vault.save(secrets, neues);
      } catch (err) {
        /* Umschlüsseln gescheitert: Vault.save schreibt daneben und benennt um,
           der Tresor ist also unversehrt und gehört weiter dem alten Passwort.
           Den schon hinterlegten neuen Wert wieder zurücknehmen, sonst zeigt
           die Keychain auf ein Passwort, das nichts mehr aufschließt. */
        if (datei) fs.rmSync(datei, { force: true });
        else if (altes.source === 'keychain') writeKeychain(altes.passphrase);
        throw err;
      }

      console.log('\nTresor mit einem neuen Masterpasswort verschlüsselt.');
      if (!datei) {
        console.log('Das neue Passwort liegt in der Keychain.');
      } else {
        console.log('Das neue Passwort steht mit Absicht nicht hier auf dem Bildschirm,');
        console.log('sondern in dieser Datei (nur für dich lesbar, 0600):');
        console.log(`  ${datei}\n`);
        console.log('So geht es weiter:');
        console.log('  1. Wert als STELLIUM_MASTER_PASSPHRASE in die Umgebung des Dienstes eintragen');
        console.log('  2. Dienst neu starten');
        console.log(`  3. Datei wieder löschen:  rm ${datei}`);
      }
      break;
    }

    case 'keychain-loeschen':
      deleteKeychain();
      console.log('Keychain-Eintrag entfernt. Ohne STELLIUM_MASTER_PASSPHRASE kommt der Server nicht mehr an den Tresor.');
      break;

    default:
      console.log(`Stellium — verschlüsselte Schlüsselablage

  setzen <name>        Schlüssel eingeben und verschlüsselt ablegen
  liste                Zeigt, welche Schlüssel im Tresor liegen (ohne Werte)
  entfernen <name>     Schlüssel löschen
  passwort-neu         Masterpasswort erneuern und Tresor neu verschlüsseln
                       (rechnet die Datenbank NICHT um — fragt vorher nach)
  keychain-loeschen    Masterpasswort aus der Keychain entfernen

Beispiel:
  npm run secret -w @stellium/server -- setzen groq

Masterpasswort kommt aus STELLIUM_MASTER_PASSPHRASE oder der macOS-Keychain.
Aktuell: ${resolvePassphrase()?.source ?? 'nicht eingerichtet'}${keychainAvailable() && readKeychain() ? ' (Keychain-Eintrag vorhanden)' : ''}`);
  }
}

main()
  // Ohne das bleibt der Prozess an offenen stdin-Handles hängen.
  .then(() => process.exit(0))
  .catch((err) => {
    console.error(`\nFehler: ${(err as Error).message}`);
    process.exit(1);
  });
