/**
 * stellium-fern-dienst — der Vermittler auf dem Pi.
 *
 * Er verwaltet `fern-host` (Bild und Eingabe), nimmt Verbindungen an, prüft
 * ID und Passwort und reicht danach beides verschlüsselt durch.
 *
 * Drei Entscheidungen, die man beim Lesen kennen sollte:
 *
 * 1. `fern-host` läuft **nur, solange jemand zusieht**. Ohne Verbindung
 *    gibt es keinen Prozess, der abgreift — TeamViewer lässt seinen Dienst
 *    dauerhaft mitlaufen und belegt dabei 815 MB.
 *
 * 2. **Es wird nicht gestaut.** Kommt die Leitung nicht nach, werden Bilder
 *    weggeworfen statt gepuffert. Ein verlorenes Bild sieht niemand, ein
 *    Rückstau von zwei Sekunden macht die Fernsteuerung unbenutzbar. Nur
 *    Schlüsselbilder werden nie verworfen — ohne sie bleibt das Bild stehen.
 *
 *    Diese Regel stand hier von Anfang an, griff aber jahrelang ins Leere.
 *    Gemessen wurde `ws.bufferedAmount`, und der zählt nur, was INNERHALB von
 *    Node wartet. Der Stau lag woanders: im Sendepuffer des Kerns, den TCP bei
 *    langer Laufzeit selbsttätig auf mehrere hundert KB vergrößert. Node gab
 *    die Bilder ab, der Kern nahm sie an, der Zähler blieb bei null — und die
 *    Schwelle löste nie aus. Auf dem Gerät gemessen (21.08.2026): 350–642 KB
 *    dauerhaft im Kern, dazu `verworfen 0` in der Anzeige. Das waren gut
 *    anderthalb Sekunden Bild, die dem Betrachter davonliefen.
 *    Deshalb wird der Rückstau jetzt dort gelesen, wo er wirklich liegt —
 *    siehe `sendestau()`.
 *
 * 4. **Die Bitrate folgt der Leitung.** Fest eingestellt waren 6000 kbit/s;
 *    die Leitung trug gemessen 1,6–2,5. Wer mehr erzeugt, als durchpasst,
 *    baut genau den Rückstau auf, den Punkt 2 verhindern soll — Verwerfen
 *    repariert dann nur noch die Folgen. `rateNachziehen()` regelt deshalb
 *    an der Ursache.
 *
 * 3. **Immer nur einer.** Ein zweiter Zuschauer würde denselben Abgriff
 *    doppelt kosten, und ein Schreibtisch, an dem zwei gleichzeitig die Maus
 *    bewegen, ist unbrauchbar.
 */
import { WebSocketServer } from 'ws';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { kennungLaden, grussBauen, antwortPruefen, Schatulle } from './anmeldung.mjs';

const ORDNER   = process.env.FERN_ORDNER ?? '/var/lib/stellium/fern';
const HOST_BIN = process.env.FERN_HOST   ?? '/usr/local/lib/stellium/fern-host';
const PORT     = Number(process.env.FERN_PORT ?? 7788);
const ZUSTAND  = path.join(ORDNER, 'zustand.json');

/* Rahmenarten, die `fern-host` ausgibt. */
const H_BILD = 1, H_ABLAGE = 2, H_MELDUNG = 3;
/* Nachrichtenarten auf der Leitung. */
const N_BILD = 1, N_ABLAGE = 2, N_INFO = 3, N_EINGABE = 4, N_STEUER = 5;

/* Mehr als das unterwegs heißt: die Leitung kommt nicht nach. Ein Bild in
   960x540 ist grob 10–40 KB; 96 KB sind also etwa drei bis neun Bilder
   Rückstand — ab da lieber verwerfen.
   Deutlich kleiner als die früheren 256 KB, und das mit Absicht: bei den
   gemessenen 2 Mbit/s sind 256 KB gut eine Sekunde Verzögerung. Genau die
   soll gar nicht erst entstehen. */
const STAU_GRENZE = 96 * 1024;

/* Wie oft der Rückstau aus /proc gelesen wird. Bei 45 Bildern/s wäre einmal
   je Bild verschwendet — die Zahl ändert sich nicht so schnell. */
const STAU_TAKT_MS = 200;

const kennung = kennungLaden(ORDNER);

/* ── Zustand für das Dashboard ───────────────────────────────── */

/* Ausdrücklich nur, OB jemand verbunden ist — nie, was er dabei sieht oder
   tut. Genau so hat Don es verlangt. */
let verbunden = null;
function zustandSchreiben() {
  const z = {
    verbunden: Boolean(verbunden),
    seit: verbunden?.seit ?? null,
    id: kennung.id,
    hafen: PORT,
    aktualisiert: new Date().toISOString(),
  };
  try {
    fs.writeFileSync(ZUSTAND + '.neu', JSON.stringify(z, null, 2), { mode: 0o644 });
    fs.renameSync(ZUSTAND + '.neu', ZUSTAND);   /* atomar, damit das Dashboard
                                                   nie eine halbe Datei liest */
  } catch { /* nicht schreiben zu können darf die Sitzung nicht beenden */ }
}

/* ── Bremse gegen Durchprobieren ─────────────────────────────── */

const fehlversuche = new Map();   /* Adresse → { anzahl, bis } */

function darfVersuchen(adresse) {
  const e = fehlversuche.get(adresse);
  if (!e) return true;
  if (Date.now() > e.bis) { fehlversuche.delete(adresse); return true; }
  return e.anzahl < 5;
}

function versuchGescheitert(adresse) {
  const e = fehlversuche.get(adresse) ?? { anzahl: 0, bis: 0 };
  e.anzahl += 1;
  /* Wartezeit verdoppelt sich: 2s, 4s, 8s … bis 5 Minuten. Wer das Passwort
     rät, kommt so auf eine Handvoll Versuche pro Stunde. */
  e.bis = Date.now() + Math.min(2000 * 2 ** e.anzahl, 300_000);
  fehlversuche.set(adresse, e);
}

function versuchGelungen(adresse) { fehlversuche.delete(adresse); }

/* ── Der Abgreifer ───────────────────────────────────────────── */

function hostStarten(sitzung, einstellungen) {
  /* 960x540 bei 45 Bildern statt 1280x720 bei 30 — beides nachgemessen.
     Die halbe Fläche kostet beim Lesen 22,7 statt 24,1 ms und beim Wandeln
     und Kodieren rund die Hälfte; erst dadurch sind 45 überhaupt erreichbar.
     Und sie passen in die Bitrate: 1280x720 in Bewegung braucht mehr, als
     diese Leitung trägt.
     Die Rate ist nur die OBERGRENZE — `rateNachziehen` regelt darunter. */
  const rateMax = einstellungen.rate ?? 2500;
  const args = [
    '--bilder', String(einstellungen.bilder ?? 45),
    '--rate',   String(rateMax),
    '--ausgabe', `${einstellungen.breite ?? 960}x${einstellungen.hoehe ?? 540}`,
    '--auftraege', String(einstellungen.auftraege ?? 2),
  ];
  sitzung.rateMax = rateMax;
  sitzung.rateJetzt = rateMax;
  const kind = spawn(HOST_BIN, args, {
    stdio: ['pipe', 'pipe', 'pipe'],
    env: {
      ...process.env,
      XDG_RUNTIME_DIR: process.env.XDG_RUNTIME_DIR ?? '/run/user/1000',
      WAYLAND_DISPLAY: process.env.WAYLAND_DISPLAY ?? 'wayland-0',
    },
  });

  /* Der Strom kommt als [Art:1][Länge:4 LE][Inhalt] — über eine Pipe
     zerfällt das in beliebige Stücke, also selbst zusammensetzen. */
  let rest = Buffer.alloc(0);
  kind.stdout.on('data', (stueck) => {
    rest = rest.length ? Buffer.concat([rest, stueck]) : stueck;
    for (;;) {
      if (rest.length < 5) return;
      const art = rest[0];
      const laenge = rest.readUInt32LE(1);
      if (rest.length < 5 + laenge) return;
      const inhalt = rest.subarray(5, 5 + laenge);
      rest = rest.subarray(5 + laenge);
      hostRahmen(sitzung, art, inhalt);
    }
  });

  kind.stderr.on('data', (d) => {
    const t = String(d).trim();
    /* x264 meldet beim Start zwei Zeilen über die CPU — das ist keine
       Störung und soll das Protokoll nicht fluten. */
    if (t && !t.startsWith('x264 [info]')) console.error('[host]', t);
  });

  kind.on('exit', (code, signal) => {
    if (sitzung.kind === kind) {
      sitzung.kind = null;
      console.error(`[host] beendet (${signal ?? code})`);
      try { sitzung.ws.close(1011, 'Abgriff beendet'); } catch { /* schon zu */ }
    }
  });

  return kind;
}

/** Ein Schlüsselbild fängt in Annex-B mit einem IDR-Kopf an. Bei
 *  `b_repeat_headers` steht davor SPS (Art 7) — daran erkennt man es. */
function istSchluesselbild(buf) {
  for (let i = 0; i + 4 < buf.length && i < 64; i++) {
    if (buf[i] === 0 && buf[i + 1] === 0 && buf[i + 2] === 1) {
      const art = buf[i + 3] & 0x1f;
      if (art === 7 || art === 5) return true;      /* SPS oder IDR */
      if (art === 1) return false;                  /* gewöhnliches Bild */
    }
  }
  return false;
}

/*
 * Der echte Rückstau: was der Kern noch nicht losgeworden ist.
 *
 * `ws.bufferedAmount` taugt dafür nicht (siehe Kopf, Punkt 2). Was zählt,
 * steht in /proc/net/tcp: Feld 4 ist `tx_queue:rx_queue`, und tx_queue sind
 * genau die Bytes, die geschrieben, aber noch nicht bestätigt sind.
 *
 * Gefunden wird die Zeile über den Port der Gegenstelle — der ist je
 * Verbindung eindeutig, anders als die Adresse. IPv6 zuerst, weil eine
 * IPv4-Verbindung auf einem Lauscher ohne Bindung als ::ffff:… dort steht.
 *
 * Nur Linux. Das ist kein Mangel: dieser Dienst läuft auf dem Pi und nirgends
 * sonst. Fehlt die Datei, liefert die Funktion 0 und es gilt wieder allein
 * der Node-Zähler — schlechter als vorher wird es dadurch nie.
 */
function sendestau(sitzung) {
  const jetzt = Date.now();
  if (jetzt - (sitzung.stauGelesen ?? 0) < STAU_TAKT_MS) return sitzung.stau ?? 0;
  sitzung.stauGelesen = jetzt;

  const port = sitzung.ws?._socket?.remotePort;
  if (!port) { sitzung.stau = 0; return 0; }
  const hex = port.toString(16).toUpperCase().padStart(4, '0');

  for (const datei of ['/proc/net/tcp6', '/proc/net/tcp']) {
    let text;
    try { text = fs.readFileSync(datei, 'utf8'); } catch { continue; }
    for (const zeile of text.split('\n')) {
      const f = zeile.trim().split(/\s+/);
      if (f.length < 5 || !f[2] || !f[4]) continue;
      if (!f[2].endsWith(':' + hex)) continue;
      const tx = parseInt(f[4].split(':')[0], 16);
      if (Number.isFinite(tx)) { sitzung.stau = tx; return tx; }
    }
  }
  sitzung.stau = 0;
  return 0;
}

/*
 * Die Bitrate an das anpassen, was wirklich durchgeht.
 *
 * Bewusst unsymmetrisch — schnell runter, langsam hoch. Ein zu hoher Wert
 * kostet sofort Verzögerung und ist eine Sekunde später noch zu spüren; ein
 * zu niedriger kostet nur etwas Schärfe. Wer beim Runterregeln zögert,
 * bezahlt das mit genau dem Ruckeln, das hier abgestellt werden soll.
 *
 * Der Rückstau ist dabei das bessere Maß als die reine Durchsatzmessung: er
 * sagt nicht nur, wie viel ankommt, sondern ob der Betrachter hinterherhängt.
 */
function rateNachziehen(sitzung) {
  const jetzt = Date.now();
  if (jetzt - (sitzung.rateGeprueft ?? 0) < 2000) return;
  sitzung.rateGeprueft = jetzt;
  if (!sitzung.kind || !sitzung.rateMax) return;

  const stau = sendestau(sitzung) + (sitzung.ws?.bufferedAmount ?? 0);
  const jetzige = sitzung.rateJetzt ?? sitzung.rateMax;
  let neu = jetzige;

  if (stau > STAU_GRENZE) {
    neu = Math.round(jetzige * 0.75);          /* Rückstau: deutlich runter */
  } else if (stau < STAU_GRENZE / 4) {
    neu = Math.round(jetzige * 1.08);          /* Luft: vorsichtig hoch */
  }
  neu = Math.max(400, Math.min(sitzung.rateMax, neu));
  if (neu === jetzige) return;

  sitzung.rateJetzt = neu;
  /* Wie überall sonst hier erst auf `writable` prüfen: nach einem
     Neustart des Abgreifers zeigt `kind` kurz auf einen Kanal, der schon zu
     ist, und ein Wurf im Bildpfad kostet dort ein Bild. */
  if (!sitzung.kind.stdin?.writable) return;
  try { sitzung.kind.stdin.write(`b${neu}\n`); } catch { /* Host ist weg */ }
}

function hostRahmen(sitzung, art, inhalt) {
  const ws = sitzung.ws;
  if (!ws || ws.readyState !== ws.OPEN) return;

  if (art === H_BILD) {
    rateNachziehen(sitzung);
    /* Beide Zähler zusammen: was in Node wartet UND was der Kern noch nicht
       losgeworden ist. Der zweite ist auf einer langsamen Leitung der weitaus
       größere — genau ihn hat die Regel früher übersehen. */
    const unterwegs = sendestau(sitzung) + ws.bufferedAmount;
    if (unterwegs > STAU_GRENZE && !istSchluesselbild(inhalt)) {
      sitzung.verworfen += 1;
      return;                       /* siehe Kopf: verwerfen statt stauen */
    }
    senden(sitzung, N_BILD, inhalt);
    sitzung.bilder += 1;
  } else if (art === H_ABLAGE) {
    senden(sitzung, N_ABLAGE, inhalt);
  } else if (art === H_MELDUNG) {
    sitzung.letzteMeldung = String(inhalt);
    senden(sitzung, N_INFO, Buffer.from(JSON.stringify({
      takt: sitzung.letzteMeldung,
      verworfen: sitzung.verworfen,
      stau: sendestau(sitzung) + ws.bufferedAmount,
      rate: sitzung.rateJetzt ?? sitzung.rateMax ?? 0,
    })));
    sitzung.verworfen = 0;
  }
}

function senden(sitzung, art, inhalt) {
  try {
    sitzung.ws.send(sitzung.hinaus.zu(art, inhalt), { binary: true });
  } catch { /* Verbindung weg — der close-Umgang räumt auf */ }
}

/* ── Verbindungen ────────────────────────────────────────────── */

const server = new WebSocketServer({ port: PORT, maxPayload: 4 * 1024 * 1024 });
console.error(`stellium-fern lauscht auf ${PORT}   ID ${kennung.id}`);
zustandSchreiben();

server.on('connection', (ws, anfrage) => {
  const adresse = anfrage.socket.remoteAddress ?? '?';

  if (!darfVersuchen(adresse)) {
    ws.close(4029, 'zu viele Versuche');
    return;
  }
  if (verbunden) {
    /* Immer nur einer — siehe Kopf. */
    ws.close(4009, 'schon jemand verbunden');
    return;
  }

  let phase = 'hallo';
  let handschlag = null;
  const sitzung = {
    ws, kind: null, hinaus: null, herein: null,
    seit: null, bilder: 0, verworfen: 0, letzteMeldung: '',
  };

  /* Wer sich nicht binnen zehn Sekunden ausweist, fliegt. Sonst könnte man
     mit offenen, halbfertigen Verbindungen den Platz blockieren. */
  const frist = setTimeout(() => {
    if (phase !== 'offen') { try { ws.close(4008, 'zu langsam'); } catch {} }
  }, 10_000);

  ws.on('message', (roh) => {
    try {
      if (phase === 'hallo') {
        const hallo = JSON.parse(String(roh));
        if (hallo.art !== 'hallo') throw new Error('erwartet: hallo');
        handschlag = grussBauen(kennung, hallo);
        if (!handschlag) throw new Error('Schlüssel unbrauchbar');
        phase = 'antwort';
        ws.send(JSON.stringify(handschlag.hinaus));
        return;
      }

      if (phase === 'antwort') {
        const antwort = JSON.parse(String(roh));
        const urteil = antwortPruefen(handschlag, antwort);
        if (!urteil.ok) {
          versuchGescheitert(adresse);
          console.error(`[anmeldung] abgewiesen von ${adresse}: ${urteil.grund}`);
          /* Der Grund geht bewusst NICHT hinaus: „Passwort stimmt nicht" wäre
             für den, der rät, eine Bestätigung, dass die ID stimmt. */
          ws.close(4003, 'abgewiesen');
          return;
        }
        versuchGelungen(adresse);
        clearTimeout(frist);
        phase = 'offen';

        sitzung.hinaus = new Schatulle(urteil.schluessel, 'pi');
        sitzung.herein = new Schatulle(urteil.schluessel, 'mac');
        sitzung.seit = new Date().toISOString();
        verbunden = sitzung;
        zustandSchreiben();

        ws.send(JSON.stringify({ art: 'offen' }));
        sitzung.kind = hostStarten(sitzung, {});
        console.error(`[sitzung] offen für ${adresse}`);
        return;
      }

      /* Ab hier ist alles verschlüsselt. */
      const paket = sitzung.herein.auf(Buffer.from(roh));
      if (!paket) {
        /* Verfälscht oder falscher Schlüssel — nicht raten, auflegen. */
        console.error('[sitzung] Nachricht ließ sich nicht entschlüsseln');
        ws.close(4002, 'kaputt');
        return;
      }

      if (paket.art === N_EINGABE) {
        /* Zeilenweise Befehle, so wie `fern-host` sie erwartet. */
        if (sitzung.kind?.stdin.writable) sitzung.kind.stdin.write(paket.inhalt);
      } else if (paket.art === N_ABLAGE) {
        if (sitzung.kind?.stdin.writable) {
          sitzung.kind.stdin.write('a ' + paket.inhalt.toString('base64') + '\n');
        }
      } else if (paket.art === N_STEUER) {
        const w = JSON.parse(paket.inhalt.toString('utf8'));
        if (w.art === 'neuStarten' && sitzung.kind) {
          /* Auflösung oder Bildrate ändern heißt: den Kodierer neu aufsetzen.
             Einfacher und verlässlicher, als ihn im Lauf umzustellen. */
          const alt = sitzung.kind;
          sitzung.kind = null;
          alt.kill('SIGTERM');
          sitzung.kind = hostStarten(sitzung, w);
        }
      }
    } catch (fehler) {
      console.error('[sitzung]', fehler.message);
      try { ws.close(4000, 'Fehler'); } catch { /* schon zu */ }
    }
  });

  const aufraeumen = () => {
    clearTimeout(frist);
    if (sitzung.kind) {
      const k = sitzung.kind;
      sitzung.kind = null;
      k.kill('SIGTERM');
      /* Wer auf SIGTERM nicht hört, bekommt nach zwei Sekunden SIGKILL —
         sonst bliebe ein Abgreifer hängen und der nächste Anlauf fände den
         Compositor besetzt. */
      const notaus = setTimeout(() => { try { k.kill('SIGKILL'); } catch {} }, 2000);
      notaus.unref();
    }
    if (verbunden === sitzung) { verbunden = null; zustandSchreiben(); }
  };

  ws.on('close', () => { console.error('[sitzung] beendet'); aufraeumen(); });
  ws.on('error', (f) => { console.error('[sitzung] Fehler:', f.message); aufraeumen(); });
});

for (const zeichen of ['SIGINT', 'SIGTERM']) {
  process.on(zeichen, () => {
    if (verbunden?.kind) { try { verbunden.kind.kill('SIGKILL'); } catch {} }
    verbunden = null;
    zustandSchreiben();
    process.exit(0);
  });
}
