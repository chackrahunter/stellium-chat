/**
 * Fernsteuerung — die Mac-Seite.
 *
 * Warum das hier im Hauptprozess läuft und nicht in der Ansicht: Der
 * Handschlag braucht **scrypt**, und das gibt es in der Browser-Krypto nicht
 * (dort ist nur PBKDF2 vorgesehen). Also läuft die ganze Verbindung hier,
 * und an die Ansicht gehen nur noch fertig entschlüsselte Bilder.
 *
 * Das ist auch aus einem zweiten Grund richtig: der Sitzungsschlüssel bleibt
 * damit im Hauptprozess. Die Ansicht bekommt ihn nie zu sehen.
 *
 * Der Bildstrom geht als H.264 weiter an die Ansicht, die ihn mit
 * `VideoDecoder` dekodiert — auf einem Mac läuft das über VideoToolbox, also
 * in Hardware und damit praktisch ohne Prozessorlast. Ihn hier zu dekodieren
 * und fertige Bildpunkte weiterzureichen wäre um Größenordnungen teurer:
 * 1280x720 in RGBA sind 3,7 MB je Bild.
 */
import crypto from 'node:crypto';
import { app, BrowserWindow, clipboard, ipcMain } from 'electron';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/*
 * Benutzt wird das **eingebaute** WebSocket von Node, nicht das Paket `ws`.
 * Das ist kein Geschmacksurteil: dieses Paket führt gar keine
 * `dependencies`, und ausgeliefert werden nur `dist`, `dist-electron` und
 * `package.json` — kein `node_modules`. Ein `import … from 'ws'` liefe hier
 * beim Entwickeln anstandslos und wäre in der fertigen App nicht vorhanden.
 * Das ist die unangenehmste Sorte Fehler: einer, den man erst beim Nutzer
 * sieht.
 *
 * Die eingebaute Fassung spricht die Browser-Schnittstelle
 * (`addEventListener`) statt der von `ws` (`on`) — daher die Schreibweise
 * unten.
 */

const KURVE = 'prime256v1';

/* Nachrichtenarten auf der Leitung — dieselben Zahlen wie im Pi-Dienst. */
const N_BILD = 1, N_ABLAGE = 2, N_INFO = 3, N_EINGABE = 4, N_STEUER = 5;

/* ── Handschlag ──────────────────────────────────────────────── */

function sitzungsschluessel(gemeinsam: Buffer, passSchluessel: Buffer, nonce: Buffer): Buffer {
  return Buffer.from(crypto.hkdfSync(
    'sha256', Buffer.concat([gemeinsam, passSchluessel]),
    nonce, Buffer.from('stellium-fern-sitzung'), 32));
}

/**
 * Jede Nachricht bekommt einen eigenen Startwert. Bei AES-GCM darf sich einer
 * mit demselben Schlüssel **nie** wiederholen — sonst fällt der Schlüssel.
 * Deshalb ein Zähler und kein Zufall: bei Zufall wächst die Wahrscheinlichkeit
 * einer Wiederholung mit der Zahl der Nachrichten, und ein Bildstrom schickt
 * sehr viele.
 */
class Schatulle {
  private zaehler = 0n;
  private kennung: number;
  constructor(private schluessel: Buffer, richtung: 'pi' | 'mac') {
    this.kennung = richtung === 'pi' ? 1 : 2;
  }
  private startwert(): Buffer {
    const b = Buffer.alloc(12);
    b.writeUInt32BE(this.kennung, 0);
    b.writeBigUInt64BE(this.zaehler++, 4);
    return b;
  }
  zu(art: number, inhalt: Buffer): Buffer {
    const iv = this.startwert();
    const c = crypto.createCipheriv('aes-256-gcm', this.schluessel, iv);
    c.setAAD(Buffer.from([art]));
    const geheim = Buffer.concat([c.update(inhalt), c.final()]);
    return Buffer.concat([Buffer.from([art]), iv, c.getAuthTag(), geheim]);
  }
  auf(paket: Buffer): { art: number; inhalt: Buffer } | null {
    if (paket.length < 1 + 12 + 16) return null;
    const art = paket[0];
    try {
      const d = crypto.createDecipheriv('aes-256-gcm', this.schluessel, paket.subarray(1, 13));
      d.setAAD(Buffer.from([art]));
      d.setAuthTag(paket.subarray(13, 29));
      return { art, inhalt: Buffer.concat([d.update(paket.subarray(29)), d.final()]) };
    } catch {
      return null;                       /* verfälscht — verwerfen, nicht raten */
    }
  }
}

/* ── Zustand einer Sitzung ───────────────────────────────────── */

type Lage = 'getrennt' | 'verbindet' | 'meldet an' | 'offen' | 'fehler';

let ws: WebSocket | null = null;
let hinaus: Schatulle | null = null;
let herein: Schatulle | null = null;
let paar: crypto.ECDH | null = null;
let passwort = '';
let lage: Lage = 'getrennt';
let letzterFehler = '';
const here = path.dirname(fileURLToPath(import.meta.url));
const DEV_URL = process.env.VITE_DEV_SERVER_URL ?? 'http://localhost:5173';

/**
 * Anfänglicher Fenstertitel des Betrachters — sichtbar, sobald das Fenster
 * entsteht (Titelleiste, Fenstermenü, Mission Control zeigen ihn schon vor
 * dem ersten Zeichnen der Seite).
 *
 * Nur Deutsch/Englisch von Hand, nicht alle 22 Sprachen: der Hauptprozess
 * kann `src/i18n` nicht importieren (siehe Kommentar bei `anschlussFrist`
 * oben), von Hand in 22 Sprachen mitgepflegt zu werden liefe genau der Idee
 * eines einzigen Wörterbuchs zuwider. `app.getLocale()` ist die Systemsprache
 * des Macs, nicht die eingestellte Oberflächensprache — hier unvermeidlich,
 * weil zu diesem Zeitpunkt noch kein Chat-Konto geladen ist.
 *
 * Das ist ausdrücklich nur der ERSTE Augenblick: Sobald die Seite geladen hat
 * und `Fernsteuerung.tsx` seinerseits `document.title = t('fern.titel')`
 * setzt, übernimmt Electron das automatisch als echten Fenstertitel (Electron
 * synchronisiert den Fenstertitel standardmäßig mit `document.title`, sofern
 * niemand `page-title-updated` abfängt — das tut hier niemand). Ab da zählt
 * die eingestellte Oberflächensprache, nicht mehr die Systemsprache.
 */
function fensterTitel(): string {
  const kurz = app.getLocale().split(/[-_]/)[0].toLowerCase();
  // Werte identisch zu i18n/de.ts bzw. i18n/en.ts, Schlüssel `fern.titel` —
  // von Hand synchron halten, falls sich der Wortlaut dort ändert.
  return kurz === 'de' ? 'Pi fernsteuern' : 'Control Pi remotely';
}

let fenster: (() => BrowserWindow | null) | null = null;

/*
 * Der Betrachter in einem eigenen Fenster.
 *
 * Bildstrom und Eingaben gehen dann NUR dorthin, nicht zusätzlich ins
 * Hauptfenster. Beides zu beliefern klingt bequemer — man müsste nirgends
 * umschalten —, hieße aber, jedes Bild zweimal über die Prozessgrenze zu
 * schieben und zweimal zu dekodieren. Bei 45 Bildern in der Sekunde ist das
 * kein Detail: die Hardware-Dekodierung läuft je Fenster einmal.
 */
let betrachter: BrowserWindow | null = null;

/* Wohin Bild, Zustand und Meldungen gehen. */
function ziel(): BrowserWindow | null {
  if (betrachter && !betrachter.isDestroyed()) return betrachter;
  return fenster?.() ?? null;
}

/* Was wir zuletzt selbst in die Ablage gelegt haben — damit wir es nicht
   gleich wieder zurückschicken und die beiden Seiten sich hochschaukeln. */
let ablageZuletzt = '';
let ablageWacht: NodeJS.Timeout | null = null;

function melden(): void {
  /* Der Zustand geht an BEIDE: das Hauptfenster braucht ihn für den
     Verbinden-Knopf, auch wenn das Bild im eigenen Fenster läuft. */
  for (const w of new Set([ziel(), fenster?.() ?? null])) {
    if (w && !w.isDestroyed()) w.webContents.send('fern:zustand', { lage, fehler: letzterFehler });
  }
}

function schliessen(grund: string): void {
  if (ablageWacht) { clearInterval(ablageWacht); ablageWacht = null; }
  if (ws) { try { ws.close(); } catch { /* schon zu */ } ws = null; }
  hinaus = herein = null; paar = null; passwort = '';
  lage = grund ? 'fehler' : 'getrennt';
  letzterFehler = grund;
  melden();
}

/* ── Zwischenablage ──────────────────────────────────────────── */

/**
 * Electron kann nicht melden, wenn sich die Ablage ändert — es gibt kein
 * Ereignis dafür. Also nachsehen. Zweimal je Sekunde ist oft genug, dass es
 * sich wie sofort anfühlt, und selten genug, dass es nichts kostet.
 */
function ablageBeobachten(): void {
  ablageZuletzt = clipboard.readText();
  ablageWacht = setInterval(() => {
    if (!ws || lage !== 'offen') return;
    const jetzt = clipboard.readText();
    if (jetzt && jetzt !== ablageZuletzt) {
      ablageZuletzt = jetzt;
      senden(N_ABLAGE, Buffer.from(jetzt, 'utf8'));
    }
  }, 500);
}

function senden(art: number, inhalt: Buffer): void {
  if (!ws || !hinaus || ws.readyState !== WebSocket.OPEN) return;
  try { ws.send(hinaus.zu(art, inhalt)); } catch { /* Leitung weg */ }
}

/* ── Verbinden ───────────────────────────────────────────────── */

/**
 * `konto`: der Anzeigename des angemeldeten Chat-Kontos. Er geht NICHT in den
 * Handschlag — der ist zu diesem Zeitpunkt noch Klartext (siehe unten, kurz
 * vor `phase = 'offen'`) — sondern erst über die verschlüsselte Leitung,
 * sobald sie steht. Leer lassen ist in Ordnung: der Pi zeigt dann „unbekannt".
 */
function verbinden(adresse: string, pw: string, konto: string): void {
  schliessen('');
  passwort = pw;
  lage = 'verbindet'; letzterFehler = ''; melden();

  paar = crypto.createECDH(KURVE);
  paar.generateKeys();

  let phase: 'gruss' | 'offen' | 'zu' = 'gruss';
  const buchse = new WebSocket(adresse);
  /* Ohne das kämen Binärnachrichten als Blob, und daraus wieder einen Buffer
     zu machen kostet bei 15 Bildern je Sekunde unnötig Arbeit. */
  buchse.binaryType = 'arraybuffer';
  ws = buchse;

  /* Wer sich nicht binnen zehn Sekunden meldet, ist nicht da. Das eingebaute
     WebSocket kennt keine eigene Frist dafür.
     `schliessen()`/`letzterFehler` tragen ab hier eine WÖRTERBUCH-KENNUNG,
     keinen fertigen Satz mehr: Der Hauptprozess hat kein `i18n/` zur
     Verfügung (tsconfig.electron.json bindet nur "electron" ein, ein Import
     aus src/ liefe gegen `rootDir`). Übersetzt wird erst in der Ansicht, die
     `fehler` aus `fern:zustand` bekommt — genau wie es net/socket.ts mit
     `ABBRUCH_KENNUNGEN` vormacht. Die Schlüssel stehen in i18n/de.ts und
     en.ts unter `fern.fehler.*`. */
  const anschlussFrist = setTimeout(() => {
    if (lage === 'verbindet') schliessen('fern.fehler.keineAntwort');
  }, 10_000);

  buchse.addEventListener('open', () => {
    clearTimeout(anschlussFrist);
    lage = 'meldet an'; melden();
    /* Zuerst nur der öffentliche Schlüssel. Nichts, woraus sich das Passwort
       herstellen ließe — der Pi muss sich als Erster ausweisen. */
    buchse.send(JSON.stringify({ art: 'hallo', oeffentlich: paar!.getPublicKey().toString('base64') }));
  });

  buchse.addEventListener('message', (ereignis: MessageEvent) => {
    const roh = ereignis.data;
    try {
      if (phase === 'gruss') {
        const gruss = JSON.parse(typeof roh === 'string' ? roh : Buffer.from(roh).toString('utf8'));
        if (gruss.art !== 'gruss') throw new Error('fern.fehler.unerwarteteAntwort');

        const salz = Buffer.from(gruss.salz, 'base64');
        const nonce = Buffer.from(gruss.nonce, 'base64');
        const passSchluessel = crypto.scryptSync(passwort, salz, 32, gruss.scrypt ?? { N: 16384, r: 8, p: 1 });
        const gemeinsam = paar!.computeSecret(Buffer.from(gruss.oeffentlich, 'base64'));
        const schluessel = sitzungsschluessel(gemeinsam, passSchluessel, nonce);

        /* Erst prüfen, ob die Gegenstelle das Passwort kennt. Stimmt das
           nicht, brechen wir ab, BEVOR wir selbst etwas herausgeben —
           sonst könnte jemand den Pi vortäuschen, unseren Beweis einsammeln
           und damit in Ruhe Passwörter durchprobieren. */
        const erwartet = crypto.createHmac('sha256', schluessel).update(nonce).update('pi').digest();
        const geliefert = Buffer.from(gruss.beweis ?? '', 'base64');
        if (geliefert.length !== erwartet.length || !crypto.timingSafeEqual(geliefert, erwartet)) {
          throw new Error('fern.fehler.passwort');
        }

        hinaus = new Schatulle(schluessel, 'mac');
        herein = new Schatulle(schluessel, 'pi');
        buchse.send(JSON.stringify({
          art: 'antwort',
          beweis: crypto.createHmac('sha256', schluessel).update(nonce).update('mac').digest('base64'),
        }));
        /* Erst ab hier, nie im „hallo" oben: der Sitzungsschlüssel steht seit
           den beiden Zeilen darüber, und nur über ihn geht der Kontoname
           hinaus — im Klartext-Handschlag wäre er für jeden Mitleser auf der
           Leitung sichtbar gewesen. Alte Pi-Dienste kennen `art: 'konto'`
           nicht und ignorieren die Nachricht stillschweigend; der Handschlag
           selbst hängt an keinem Feld darin. */
        if (konto) senden(N_STEUER, Buffer.from(JSON.stringify({ art: 'konto', name: konto }), 'utf8'));
        phase = 'offen';
        return;
      }

      if (phase === 'offen' && !hinaus) return;

      /* Die erste Nachricht nach dem Beweis ist noch Text: "offen". */
      if (lage !== 'offen') {
        const o = JSON.parse(typeof roh === 'string' ? roh : Buffer.from(roh).toString('utf8'));
        if (o.art === 'offen') {
          lage = 'offen'; melden();
          ablageBeobachten();
        }
        return;
      }

      if (typeof roh === 'string') return;      /* nach dem Handschlag nur Binäres */
      const paket = herein!.auf(Buffer.from(roh));
      if (!paket) return;                /* verfälscht — stillschweigend weg */

      const f = ziel();
      if (!f) return;
      if (paket.art === N_BILD) {
        f.webContents.send('fern:bild', paket.inhalt);
      } else if (paket.art === N_ABLAGE) {
        const text = paket.inhalt.toString('utf8');
        /* Merken, bevor wir schreiben — sonst hält unsere eigene Wacht das
           für eine neue Änderung und schickt es sofort zurück. */
        ablageZuletzt = text;
        clipboard.writeText(text);
      } else if (paket.art === N_INFO) {
        f.webContents.send('fern:info', JSON.parse(paket.inhalt.toString('utf8')));
      }
    } catch (fehler) {
      schliessen((fehler as Error).message);
    }
  });

  buchse.addEventListener('error', () => {
    clearTimeout(anschlussFrist);
    /* Das eingebaute WebSocket verrät im Fehlerereignis absichtlich nichts
       Näheres — sonst ließe sich von einer Seite aus abtasten, was im Netz
       dahinter erreichbar ist. Der Grund kommt deshalb aus dem close-Code. */
  });
  /* `CloseEvent` steht in diesen Typdefinitionen nicht — der Zuschnitt hier
     reicht, wir brauchen nur den Code. */
  buchse.addEventListener('close', (ereignis: { code: number }) => {
    clearTimeout(anschlussFrist);
    const code = ereignis.code;
    if (lage === 'offen' || lage === 'meldet an' || lage === 'verbindet') {
      const gruende: Record<number, string> = {
        /* 4003 ist derselbe Fall wie oben (falsches Passwort) — nur auf einer
           anderen Ebene erkannt: dort die Antwort auf den Handschlag, hier
           ein Schließen-Code vom Pi-Dienst selbst. Dieselbe Kennung, damit
           in der Ansicht nicht zwei Sätze für dieselbe Sache stehen. */
        4003: 'fern.fehler.passwort',
        4009: 'fern.fehler.besetzt',
        4029: 'fern.fehler.zuVieleVersuche',
        4008: 'fern.fehler.zeitUeberschritten',
      };
      schliessen(gruende[code] ?? (lage === 'offen' ? '' : 'fern.fehler.allgemein'));
    }
  });
}

/* ── Anmeldung beim Hauptprozess ─────────────────────────────── */

export function fernsteuerungEinrichten(holeFenster: () => BrowserWindow | null): void {
  fenster = holeFenster;

  ipcMain.handle('fern:verbinden', (_e, adresse: string, pw: string, konto: string) => {
    verbinden(adresse, pw, konto);
    return true;
  });
  ipcMain.handle('fern:trennen', () => { schliessen(''); return true; });
  ipcMain.handle('fern:lage', () => ({ lage, fehler: letzterFehler }));

  /*
   * Den Betrachter in ein eigenes Fenster holen.
   *
   * Es lädt dieselbe Oberfläche mit `#fern` — deshalb braucht es weder einen
   * zweiten Bau noch eine zweite Vorlage. Das Anmelden am Chatserver
   * unterbleibt dort (siehe main.tsx): das Fenster zeigt nur den Bildschirm
   * des Pi, alles andere bleibt im Hauptfenster.
   *
   * Steht es schon, wird es nach vorn geholt statt ein zweites zu öffnen —
   * zwei Fenster auf denselben Strom hieße zweimal dekodieren.
   */
  ipcMain.handle('fern:fenster', () => {
    if (betrachter && !betrachter.isDestroyed()) {
      betrachter.show();
      betrachter.focus();
      return true;
    }
    betrachter = new BrowserWindow({
      width: 1280,
      height: 760,
      minWidth: 640,
      minHeight: 400,
      show: false,
      backgroundColor: '#080b16',
      title: fensterTitel(),
      webPreferences: {
        preload: path.join(here, 'preload.mjs'),
        additionalArguments: [`--stellium-locale=${app.getLocale()}`],
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: false,
      },
    });
    betrachter.once('ready-to-show', () => betrachter?.show());
    /* Zuerst aufräumen, dann den Zustand melden — sonst zeigt das
       Hauptfenster den Knopf noch als "im eigenen Fenster", während das
       Fenster schon zu ist. */
    betrachter.on('closed', () => {
      betrachter = null;
      fenster?.()?.webContents.send('fern:zustand', { lage, fehler: letzterFehler });
    });

    const ziel_url = process.env.VITE_DEV_SERVER_URL ?? DEV_URL;
    if (process.env.VITE_DEV_SERVER_URL || !app.isPackaged) {
      void betrachter.loadURL(`${ziel_url}#fern`);
    } else {
      void betrachter.loadFile(path.join(here, '../dist/index.html'), { hash: 'fern' });
    }
    return true;
  });

  ipcMain.handle('fern:fensterOffen', () => Boolean(betrachter && !betrachter.isDestroyed()));

  /* Eingaben kommen als fertige Zeilen aus der Ansicht — sie weiß, wo der
     Zeiger auf der Leinwand steht, der Hauptprozess nicht. */
  ipcMain.on('fern:eingabe', (_e, zeilen: string) => {
    if (typeof zeilen === 'string' && zeilen.length < 4096) {
      senden(N_EINGABE, Buffer.from(zeilen, 'utf8'));
    }
  });

  ipcMain.on('fern:steuer', (_e, wunsch: unknown) => {
    senden(N_STEUER, Buffer.from(JSON.stringify(wunsch), 'utf8'));
  });
}

export function fernsteuerungBeenden(): void {
  if (betrachter && !betrachter.isDestroyed()) betrachter.close();
  betrachter = null; schliessen(''); }
