/**
 * Die Fernsteuerung im Browser — der Chat-Server als Vermittler zum Pi.
 *
 * WARUM ÜBER DEN SERVER UND NICHT DIREKT. Der Pi-Dienst lauscht auf
 * `ws://…:7788`, ohne TLS (Begründung in server-setup/fernsteuerung/
 * LIESMICH.md). Eine Seite, die über https geladen ist, darf dorthin gar
 * nicht wählen — „mixed content", in Safari wie in Chrome hart gesperrt. Ein
 * eigenes Zertifikat für 7788 hieße, auf dem Pi einen zweiten TLS-Endpunkt
 * zu pflegen und die CSP für eine weitere Adresse zu öffnen. Über den Server
 * läuft alles unter derselben Herkunft wie die Oberfläche (`wss://<chat>/
 * api/fern/leitung`), die CSP bleibt, wie sie ist, und nginx reicht die
 * Leitung schon heute weiter (stellium-proxy.conf).
 *
 * WARUM DER HANDSCHLAG HIER STATTFINDET UND NICHT IM BROWSER. Die
 * Desktop-App holt Adresse und Passwort über `/api/fern/zugang` im Klartext
 * in die Ansicht und reicht sie an den Hauptprozess weiter. Für den Browser
 * gibt es diesen Weg nicht: das Passwort verlässt den Server gar nicht erst.
 * Der Server kennt es ohnehin (er bewahrt es verschlüsselt auf und gibt es
 * der Desktop-App heraus), rechnet scrypt mit Node selbst und steht damit
 * auf der Seite des „Macs" im Handschlag. Der Browser bekommt weder
 * Passwort noch Adresse noch Sitzungsschlüssel — nur das Bild, über die
 * TLS-Leitung, die er zum Chat ohnehin hat. Eine scrypt-Bibliothek im
 * Browser wird damit überflüssig.
 *
 * DIE PRÜFUNGEN VON `/api/fern/zugang` GELTEN HIER GENAUSO: gültiges Token,
 * Recht `fern.zugriff`, ein hinterlegter Zugang. Dazu eine Bremse je Konto,
 * weil jeder Aufbau auf dem Pi scrypt kostet und ein Fehlschlag dort die
 * Sperre für die gemeinsame Absenderadresse hochzählt.
 *
 * DER NAME KOMMT VOM SERVER. Die Desktop-App schickt ihren Anzeigenamen
 * selbst, und er bleibt eine Behauptung (fern-dienst.mjs). Hier setzt ihn der
 * Server aus dem angemeldeten Konto; der Browser kann `konto` gar nicht
 * schicken, siehe `STEUER_ERLAUBT`.
 *
 * Nachrichten Browser ↔ Server: Text ist JSON, Binär ist genau ein H.264-
 * Häppchen. Die Schließ-Codes des Pi (4003, 4008, 4010, 4029) gehen
 * unverändert weiter, dazu eigene: 4401 nicht angemeldet, 4403 kein Recht,
 * 4404 nichts hinterlegt, 4504 Pi nicht erreichbar, 4011 Browser kommt nicht
 * mehr hinterher.
 */
import crypto from 'node:crypto';
import { promisify } from 'node:util';
import type { FastifyInstance } from 'fastify';
import type { WebSocket as WsBuchse } from 'ws';
import { verifyToken } from '../auth.js';
import * as users from '../services/users.js';
import * as store from '../services/store.js';
import * as fernzugang from '../services/fernzugang.js';

const scrypt = promisify(crypto.scrypt) as (
  pw: string, salz: Buffer, laenge: number, optionen: crypto.ScryptOptions,
) => Promise<Buffer>;

const KURVE = 'prime256v1';
const N_BILD = 1, N_ABLAGE = 2, N_INFO = 3, N_EINGABE = 4, N_STEUER = 5;

/* Was der Browser als Steuerwunsch schicken darf. `konto` fehlt mit Absicht
   (den Namen setzt der Server), `neuStarten` auch: es startet den Abgriff für
   ALLE Zuschauer neu, und die Browser-Ansicht bietet es nirgends an. */
const STEUER_ERLAUBT = new Set(['steuerung']);

/* Bremse: so viele Aufbauversuche je Konto und Minute, so viele Leitungen
   gleichzeitig. Mehr als zwei offene Fenster auf denselben Pi hat niemand
   einen Grund zu haben, und der Pi nimmt ohnehin nur vier Zuschauer. */
const VERSUCHE_JE_MINUTE = 6;
const GLEICHZEITIG_JE_KONTO = 2;

/* Wie lange die Anmeldenachricht auf sich warten lassen darf. */
const ANMELDE_FRIST_MS = 5000;
/* Wie lange der Aufbau zum Pi dauern darf — dieselbe Frist wie in
   electron/fernsteuerung.ts. */
const PI_FRIST_MS = 10_000;
/* Wie lange der Server auf den lokalen Versuch wartet, bevor er es unter der
   hinterlegten Adresse probiert (siehe `ziele`). */
const LOKAL_FRIST_MS = 1500;
/* Hängt der Browser so weit hinterher, ist die Leitung nicht mehr zu retten.
   Schutz des Servers, keine Regelung — die macht der Pi (siehe unten). */
const RUECKSTAND_HART = 8 * 1024 * 1024;

const versuche = new Map<string, number[]>();
const offeneLeitungen = new Map<string, number>();

/** Nur exportiert für die Prüfung: Zähler zwischen zwei Läufen leeren. */
export function bremseZuruecksetzen(): void { versuche.clear(); offeneLeitungen.clear(); }

function darfVersuchen(userId: string): boolean {
  const jetzt = Date.now();
  const liste = (versuche.get(userId) ?? []).filter((t) => jetzt - t < 60_000);
  if (liste.length >= VERSUCHE_JE_MINUTE) { versuche.set(userId, liste); return false; }
  liste.push(jetzt);
  versuche.set(userId, liste);
  return true;
}

/* ── Handschlag, Seite „Mac" — dieselbe Rechnung wie in anmeldung.mjs ── */

function sitzungsschluessel(gemeinsam: Buffer, passSchluessel: Buffer, nonce: Buffer): Buffer {
  return Buffer.from(crypto.hkdfSync(
    'sha256', Buffer.concat([gemeinsam, passSchluessel]),
    nonce, Buffer.from('stellium-fern-sitzung'), 32));
}

/** Zähler statt Zufall als Startwert — Begründung in anmeldung.mjs. */
class Schatulle {
  private zaehler = 0n;
  private kennung: number;
  constructor(private schluessel: Buffer, richtung: 'pi' | 'mac') {
    this.kennung = richtung === 'pi' ? 1 : 2;
  }
  zu(art: number, inhalt: Buffer): Buffer {
    const iv = Buffer.alloc(12);
    iv.writeUInt32BE(this.kennung, 0);
    iv.writeBigUInt64BE(this.zaehler++, 4);
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
      return null;
    }
  }
}

/**
 * Wohin gewählt wird.
 *
 * Der Chat-Server steht in der Regel auf DEMSELBEN Pi wie der Fern-Dienst,
 * die hinterlegte Adresse ist aber die von draußen (für die Desktop-Apps).
 * Von innen auf die eigene öffentliche Adresse zu wählen braucht einen
 * Router, der „NAT-Loopback" kann — das ist nirgends zugesagt. Deshalb zuerst
 * derselbe Port auf 127.0.0.1, danach die hinterlegte Adresse.
 *
 * Ein Sicherheitsverlust ist das nicht: vertraut wird nicht der Adresse,
 * sondern dem Handschlag, in dem sich der Pi ZUERST mit dem Passwort
 * ausweisen muss. Was dort lauscht und das Passwort nicht kennt, bekommt
 * nichts. Die Adresse wählt ohnehin nicht der Browser, sondern der Server
 * aus seinem Tresor — ein Aufrufer kann ihn nirgendwohin schicken.
 */
export function ziele(adresse: string): string[] {
  let url: URL;
  try { url = new URL(adresse); } catch { return []; }
  if (url.protocol !== 'ws:' && url.protocol !== 'wss:') return [];
  const lokal = `ws://127.0.0.1:${url.port || (url.protocol === 'wss:' ? 443 : 80)}`;
  const alle = url.protocol === 'ws:' && /^(127\.0\.0\.1|localhost|\[::1\])$/.test(url.hostname)
    ? [adresse] : [lokal, adresse];
  return alle;
}

/** Öffnet eine Leitung zum Pi oder gibt `null` zurück. */
function wählen(ziel: string, fristMs: number): Promise<WebSocket | null> {
  return new Promise((fertig) => {
    let buchse: WebSocket;
    try { buchse = new WebSocket(ziel); } catch { fertig(null); return; }
    buchse.binaryType = 'arraybuffer';
    const frist = setTimeout(() => { try { buchse.close(); } catch { /* zu */ } fertig(null); }, fristMs);
    buchse.addEventListener('open', () => { clearTimeout(frist); fertig(buchse); }, { once: true });
    buchse.addEventListener('close', () => { clearTimeout(frist); fertig(null); }, { once: true });
  });
}

/* ── Die Leitung ─────────────────────────────────────────────── */

function schliessen(browser: WsBuchse, code: number): void {
  try { browser.close(code); } catch { /* schon zu */ }
}

async function leitung(browser: WsBuchse): Promise<void> {
  /* 1. Anmelden — das Token geht in der ersten Nachricht, nicht in der
     Adresse: Adressen landen in Protokollen (nginx, Fastify). */
  const anmeldung = await new Promise<{ token?: string } | null>((fertig) => {
    const frist = setTimeout(() => fertig(null), ANMELDE_FRIST_MS);
    browser.once('message', (roh, binaer) => {
      clearTimeout(frist);
      if (binaer) { fertig(null); return; }
      try { fertig(JSON.parse(String(roh))); } catch { fertig(null); }
    });
    browser.once('close', () => { clearTimeout(frist); fertig(null); });
  });
  const userId = typeof anmeldung?.token === 'string' ? verifyToken(anmeldung.token) : null;
  if (!userId) { schliessen(browser, 4401); return; }
  if (!users.may(userId, 'fern.zugriff')) { schliessen(browser, 4403); return; }
  if ((offeneLeitungen.get(userId) ?? 0) >= GLEICHZEITIG_JE_KONTO || !darfVersuchen(userId)) {
    schliessen(browser, 4029);
    return;
  }
  const zugang = fernzugang.zugangLesen();
  const kandidaten = zugang ? ziele(zugang.adresse) : [];
  if (!zugang || !kandidaten.length) { schliessen(browser, 4404); return; }

  offeneLeitungen.set(userId, (offeneLeitungen.get(userId) ?? 0) + 1);
  let abgemeldet = false;
  const abmelden = () => {
    if (abgemeldet) return;
    abgemeldet = true;
    const n = (offeneLeitungen.get(userId) ?? 1) - 1;
    if (n > 0) offeneLeitungen.set(userId, n); else offeneLeitungen.delete(userId);
  };
  browser.once('close', abmelden);

  const lage = (l: string) => {
    if (browser.readyState === browser.OPEN) browser.send(JSON.stringify({ art: 'lage', lage: l }));
  };
  lage('verbindet');

  /* 2. Zum Pi wählen. */
  let pi: WebSocket | null = null;
  for (let i = 0; i < kandidaten.length && !pi; i++) {
    pi = await wählen(kandidaten[i], i < kandidaten.length - 1 ? LOKAL_FRIST_MS : PI_FRIST_MS);
  }
  if (browser.readyState !== browser.OPEN) { try { pi?.close(); } catch { /* zu */ } abmelden(); return; }
  if (!pi) { schliessen(browser, 4504); abmelden(); return; }
  const buchse = pi;
  lage('meldet an');

  /* 3. Handschlag. Der Pi weist sich zuerst aus — erst danach geht unser
     Beweis hinaus (siehe anmeldung.mjs, warum die Reihenfolge der Punkt ist). */
  const paar = crypto.createECDH(KURVE);
  paar.generateKeys();
  let phase: 'gruss' | 'offen?' | 'offen' = 'gruss';
  let hinaus: Schatulle | null = null;
  let herein: Schatulle | null = null;
  let handschlagLaeuft = false;

  const aufbauFrist = setTimeout(() => {
    if (phase !== 'offen') { schliessen(browser, 4008); try { buchse.close(); } catch { /* zu */ } }
  }, PI_FRIST_MS);

  const anPi = (art: number, inhalt: Buffer) => {
    if (!hinaus || buchse.readyState !== WebSocket.OPEN) return;
    try { buchse.send(hinaus.zu(art, inhalt)); } catch { /* Leitung weg */ }
  };

  /* Rückmeldung über die Leitung zum Browser — siehe `leitungMelden` im
     Pi-Dienst. Ohne sie misst der Pi nur seine eigene Leitung zu diesem
     Server, und die ist auf demselben Gerät praktisch unendlich schnell:
     er regelte auf die Höchstrate, und der Rückstau sammelte sich
     unbemerkt hier und in nginx, statt dort, wo er verworfen wird. */
  let gesendet = 0;
  let quittiert = 0;
  let laufzeitMs = 0;
  const durchsatzProben: Array<[number, number]> = [];
  let pingAb = 0;
  let pongOffen = false;
  browser.on('pong', () => {
    pongOffen = false;
    const ms = Date.now() - pingAb;
    laufzeitMs = laufzeitMs ? Math.min(laufzeitMs, ms) : ms;
  });
  const lebenszeichen = setInterval(() => {
    /* Zwei unbeantwortete Fragen — der Browser ist weg (Telefon gesperrt,
       Netz gewechselt). Den Platz auf dem Pi sofort freigeben, statt dessen
       eigene 20 Sekunden abzuwarten. */
    if (pongOffen && Date.now() - pingAb > 10_000) { try { browser.terminate(); } catch { /* weg */ } return; }
    if (!pongOffen) { pongOffen = true; pingAb = Date.now(); try { browser.ping(); } catch { /* weg */ } }
  }, 2000);
  const melder = setInterval(() => {
    if (phase !== 'offen') return;
    const jetzt = Date.now();
    durchsatzProben.push([jetzt, quittiert]);
    while (durchsatzProben.length > 1 && jetzt - durchsatzProben[0][0] > 3000) durchsatzProben.shift();
    const [t0, q0] = durchsatzProben[0];
    const durchsatzKbit = jetzt - t0 >= 1000 ? Math.round((quittiert - q0) * 8 / (jetzt - t0)) : 0;
    anPi(N_STEUER, Buffer.from(JSON.stringify({
      art: 'leitung', unterwegs: Math.max(0, gesendet - quittiert), laufzeitMs, durchsatzKbit,
    }), 'utf8'));
  }, 250);

  const aufraeumen = () => {
    clearTimeout(aufbauFrist);
    clearInterval(lebenszeichen);
    clearInterval(melder);
    abmelden();
  };

  buchse.send(JSON.stringify({ art: 'hallo', oeffentlich: paar.getPublicKey().toString('base64') }));

  buchse.addEventListener('message', (ereignis: MessageEvent) => {
    const roh = ereignis.data as ArrayBuffer | string;
    const alsText = () => (typeof roh === 'string' ? roh : Buffer.from(roh).toString('utf8'));
    if (phase === 'gruss') {
      if (handschlagLaeuft) return;
      handschlagLaeuft = true;
      void (async () => {
        try {
          const gruss = JSON.parse(alsText());
          if (gruss.art !== 'gruss') throw new Error('unerwartet');
          const salz = Buffer.from(String(gruss.salz), 'base64');
          const nonce = Buffer.from(String(gruss.nonce), 'base64');
          /* Asynchron: scrypt kostet hier ~16 MB und spürbare Rechenzeit —
             synchron hielte es für diese Dauer den ganzen Chat an. */
          const passSchluessel = await scrypt(zugang.passwort, salz, 32, gruss.scrypt ?? { N: 16384, r: 8, p: 1 });
          const gemeinsam = paar.computeSecret(Buffer.from(String(gruss.oeffentlich), 'base64'));
          const schluessel = sitzungsschluessel(gemeinsam, passSchluessel, nonce);
          const erwartet = crypto.createHmac('sha256', schluessel).update(nonce).update('pi').digest();
          const geliefert = Buffer.from(String(gruss.beweis ?? ''), 'base64');
          if (geliefert.length !== erwartet.length || !crypto.timingSafeEqual(geliefert, erwartet)) {
            /* Falsches Passwort hinterlegt — oder am anderen Ende ist nicht
               der Pi. Wir haben nichts preisgegeben. */
            schliessen(browser, 4003);
            try { buchse.close(); } catch { /* zu */ }
            return;
          }
          hinaus = new Schatulle(schluessel, 'mac');
          herein = new Schatulle(schluessel, 'pi');
          buchse.send(JSON.stringify({
            art: 'antwort',
            beweis: crypto.createHmac('sha256', schluessel).update(nonce).update('mac').digest('base64'),
          }));
          const name = store.getSelf(userId)?.displayName ?? '';
          if (name) anPi(N_STEUER, Buffer.from(JSON.stringify({ art: 'konto', name }), 'utf8'));
          phase = 'offen?';
        } catch {
          schliessen(browser, 4000);
          try { buchse.close(); } catch { /* zu */ }
        }
      })();
      return;
    }
    if (phase === 'offen?') {
      try {
        if (JSON.parse(alsText()).art === 'offen') {
          phase = 'offen';
          clearTimeout(aufbauFrist);
          lage('offen');
        }
      } catch { /* weiter warten */ }
      return;
    }
    if (typeof roh === 'string' || !herein) return;
    const paket = herein.auf(Buffer.from(roh));
    if (!paket || browser.readyState !== browser.OPEN) return;
    if (browser.bufferedAmount > RUECKSTAND_HART) { schliessen(browser, 4011); try { buchse.close(); } catch { /* zu */ } return; }
    if (paket.art === N_BILD) {
      gesendet += paket.inhalt.length;
      browser.send(paket.inhalt, { binary: true });
    } else if (paket.art === N_INFO) {
      try { browser.send(JSON.stringify({ art: 'info', info: JSON.parse(paket.inhalt.toString('utf8')) })); } catch { /* kaputt */ }
    } else if (paket.art === N_ABLAGE) {
      browser.send(JSON.stringify({ art: 'ablage', text: paket.inhalt.toString('utf8') }));
    }
  });

  buchse.addEventListener('close', (ereignis: { code: number }) => {
    aufraeumen();
    /* Die Codes des Pi unverändert weiter — die Ansicht kennt sie schon. */
    const code = ereignis.code >= 4000 && ereignis.code < 5000 ? ereignis.code : 1000;
    schliessen(browser, code);
  });

  browser.on('message', (roh, binaer) => {
    if (binaer || phase !== 'offen') return;
    let n: { art?: string; zeilen?: unknown; wunsch?: { art?: unknown }; text?: unknown; n?: unknown };
    try { n = JSON.parse(String(roh)); } catch { return; }
    if (n.art === 'q' && typeof n.n === 'number' && n.n >= quittiert && n.n <= gesendet) {
      quittiert = n.n;
    } else if (n.art === 'eingabe' && typeof n.zeilen === 'string' && n.zeilen.length < 4096) {
      anPi(N_EINGABE, Buffer.from(n.zeilen, 'utf8'));
    } else if (n.art === 'steuer' && n.wunsch && STEUER_ERLAUBT.has(String(n.wunsch.art))) {
      anPi(N_STEUER, Buffer.from(JSON.stringify(n.wunsch), 'utf8'));
    } else if (n.art === 'ablage' && typeof n.text === 'string' && n.text.length < 1024 * 1024) {
      anPi(N_ABLAGE, Buffer.from(n.text, 'utf8'));
    }
  });
  browser.on('close', () => {
    aufraeumen();
    try { buchse.close(); } catch { /* zu */ }
  });
}

export function registerFernleitung(app: FastifyInstance): void {
  app.register(async (scope) => {
    scope.get('/api/fern/leitung', { websocket: true }, (socket) => {
      void leitung(socket as unknown as WsBuchse).catch(() => schliessen(socket as unknown as WsBuchse, 1011));
    });
  });
}
