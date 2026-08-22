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
import { spawn, execFile } from 'node:child_process';
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

/*
 * Wieviel Rückstand erlaubt ist — als **Zeit**, nicht als Bytes.
 *
 * Hier stand lange `96 * 1024`, gewählt für 960x540 bei rund 2 Mbit/s. Auf
 * kurzer Leitung ist eine feste Byte-Zahl auch richtig: dort ist alles, was
 * unterwegs ist, tatsächlich Rückstand.
 *
 * Über eine lange Leitung stimmt das nicht mehr. Bei 236 ms Laufzeit müssen
 * für 6 Mbit/s dauerhaft rund 176 KB unterwegs sein — das ist die Füllung
 * des Rohrs, kein Stau. Die alte Regel hielt genau diese Füllung für
 * Überlastung und drosselte, bis weniger als 96 KB unterwegs waren. Damit
 * war der Durchsatz fest gedeckelt:
 *
 *     96 KB × 8 / 0,236 s ≈ 3,3 Mbit/s
 *
 * Gemessen wurde genau das: Regelung bei 2531–3375 kbit/s, während der Kern
 * `delivery_rate 4,4 Mbit/s` meldete und dabei `app_limited` setzte — er
 * wartete auf Daten. Die Regel hat sich selbst ausgebremst und das Bild
 * unnötig weich gemacht. Auf dem Schreibtisch nebenan fiel das nie auf, weil
 * dort die Laufzeit unter einer Millisekunde liegt und die Rohrfüllung damit
 * praktisch null ist.
 *
 * Jetzt wird abgezogen, was ohnehin unterwegs sein muss (Rate × Laufzeit),
 * und nur der Rest zählt als Stau. Der darf höchstens diese Zeit kosten.
 */
const STAU_ZEIT_S = 0.15;
/* Wie lange eine Messung aus `ss` gilt. Danach zählt sie nicht mehr, und es
   gilt wieder die strenge Rechnung ohne Rohrfüllung — lieber zu vorsichtig
   als auf Grundlage von Zahlen, die nicht mehr stimmen. */
const LEITUNG_FRIST_MS = 6000;
/* Selbst bei kleiner Rate soll nicht schon ein einzelnes Bild als Stau
   gelten — ein Schlüsselbild ist gut und gern 100 KB. */
const STAU_MINDEST = 64 * 1024;

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
    /* Wie schnell es gerade läuft — Takt, Rückstau, Verworfene.
       Das ist KEIN Bruch mit der Regel darüber: hier steht, wie schnell
       Bilder fließen, nirgends WAS auf ihnen zu sehen ist.
       Der Grund dafür ist praktischer Natur: um zu messen, wie sich die
       Fernsteuerung im Betrieb schlägt, wurde bisher ein zweiter Abgriff
       daneben gestartet — und der halbiert auf vier Kernen genau das, was
       er messen soll. Mehrere Messreihen sind daran gescheitert. Die
       laufende Sitzung selbst berichten zu lassen, kostet nichts und
       verfälscht nichts. */
    leistung: verbunden ? {
      takt: verbunden.letzteMeldung || null,
      stau: verbunden.stau ?? 0,
      rate: verbunden.rateJetzt ?? null,
      verworfenGesamt: verbunden.verworfenGesamt ?? 0,
      bilder: verbunden.bilder ?? 0,
    } : null,
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
  /* OHNE `--ausgabe`: der Host sendet dann in der Größe des Schirms, also
     pixelgenau und ohne jede Skalierung (SWS_POINT statt Bilinear).

     Verkleinern klingt nach dem naheliegenden Weg zu mehr Bildern, bringt
     hier aber nichts. Auf dem Gerät abgelesen, während es lief:
         lesen 55,1 ms · Farbe 5,3 ms · kodieren 2,5 ms
     Der Abgriff holt IMMER den ganzen Schirm — was danach verkleinert wird,
     ändert daran nichts. Und Farbe und Kodieren laufen auf einem eigenen
     Faden; zusammen kosten sie 7,8 ms gegen 55,1 fürs Lesen. In voller
     Größe werden daraus etwa 20 ms — immer noch weit unter dem Lesen, das
     den Takt allein bestimmt. Volle Auflösung ist also praktisch gratis.
     Sie kostet Bandbreite, nicht Bilder — und darum kümmert sich
     `rateNachziehen`.

     Die Rate ist nur die OBERGRENZE. Sie darf hoch stehen, seit die
     Regelung den echten Rückstau sieht: gemessen trägt die Leitung
     2,2–4,4 Mbit/s, und wo sie mehr hergibt, soll das Bild schärfer werden
     statt Reserve zu verschenken. */
  const rateMax = einstellungen.rate ?? 6000;
  /* Weder `--auftraege` noch `--faeden`: der Host bringt die gemessenen
     Werte selbst mit (1 Anforderung, 4 Fäden). Sie hier zu wiederholen hieße
     nur, sie an zwei Stellen pflegen zu müssen — und beim nächsten Mal steht
     an einer davon etwas Veraltetes. */
  const args = [
    '--bilder', String(einstellungen.bilder ?? 45),
    '--rate',   String(rateMax),
  ];
  if (einstellungen.auftraege) args.push('--auftraege', String(einstellungen.auftraege));
  /* Nur wenn ausdrücklich gewünscht — sonst bleibt es bei der Schirmgröße.
     Die Höhe zieht der Host am Seitenverhältnis nach, damit nichts staucht. */
  if (einstellungen.breite) {
    args.push('--ausgabe', `${einstellungen.breite}x${einstellungen.hoehe ?? 0}`);
  }
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
  /* Auch den eigenen Port prüfen. Der Port der Gegenstelle ist je Rechner
     eindeutig, aber zwei verschiedene Rechner können denselben erwischen —
     und dann stünde hier der Rückstau einer fremden Verbindung. */
  const hexHier = PORT.toString(16).toUpperCase().padStart(4, '0');

  for (const datei of ['/proc/net/tcp6', '/proc/net/tcp']) {
    let text;
    try { text = fs.readFileSync(datei, 'utf8'); } catch { continue; }
    for (const zeile of text.split('\n')) {
      const f = zeile.trim().split(/\s+/);
      if (f.length < 5 || !f[1] || !f[2] || !f[4]) continue;
      if (!f[2].endsWith(':' + hex)) continue;
      if (!f[1].endsWith(':' + hexHier)) continue;
      const tx = parseInt(f[4].split(':')[0], 16);
      if (Number.isFinite(tx)) {
        sitzung.stau = tx;
        /* Kurzer Verlauf für die Wachstumsprüfung. Fünf Messungen sind eine
           Sekunde — lang genug, um Zufall auszuschließen, kurz genug, um
           schneller zu sein als die Ratenregelung mit ihren zwei Sekunden. */
        const v = (sitzung.stauVerlauf ??= []);
        v.push(tx);
        if (v.length > 5) v.shift();
        return tx;
      }
    }
  }
  sitzung.stau = 0;
  return 0;
}

/*
 * Was der Kern über die Leitung weiß.
 *
 * `/proc/net/tcp` liefert nur den Rückstau. Laufzeit und tatsächlich
 * erreichten Durchsatz kennt allein die TCP-Schicht, und `ss -tni` gibt sie
 * heraus. Beides ist hier nötig: ohne Laufzeit lässt sich Rohrfüllung nicht
 * von Rückstau trennen, und ohne gemessenen Durchsatz müsste sich die
 * Regelung in kleinen Schritten an die Obergrenze herantasten.
 *
 * Bewusst nebenläufig und höchstens alle zwei Sekunden: ein Prozessstart im
 * Bildpfad wäre genau die Art Ruckler, die hier abgestellt werden soll.
 * Fehlt `ss`, bleiben beide Werte leer — dann gilt wieder die alte Rechnung
 * ohne Rohrfüllung, und schlechter als vorher wird es dadurch nie.
 */
function leitungMessen(sitzung) {
  const jetzt = Date.now();
  if (jetzt - (sitzung.leitungGelesen ?? 0) < 2000) return;
  sitzung.leitungGelesen = jetzt;
  const port = sitzung.ws?._socket?.remotePort;
  if (!port) return;
  execFile('ss', ['-tni', `sport = :${PORT} and dport = :${port}`],
    { timeout: 1500 }, (fehler, aus) => {
      if (fehler || !aus) return;
      /* `minrtt` und NICHT `rtt`.
         `rtt` ist die aktuelle Laufzeit — die durch Warteschlangen bereits
         verlängert ist. Damit würde sich der Fehler selbst verstärken:
         mehr Stau → höhere gemessene Laufzeit → größer gerechnete
         Rohrfüllung → echter Stau wird unsichtbar → hochregeln → noch mehr
         Stau. `minrtt` ist die kürzeste je gesehene Laufzeit, also die
         Strecke ohne Warteschlange — genau das, was die Rohrfüllung meint.
         Gemessen auf dieser Leitung: rtt 236,0 ms, minrtt 224,5 ms; unter
         Last laufen die beiden weit auseinander. */
      const l = /\bminrtt:([\d.]+)/.exec(aus) ?? /\brtt:([\d.]+)/.exec(aus);
      const d = /\bdelivery_rate (\d+)bps/.exec(aus);
      if (l) sitzung.laufzeitMs   = Number(l[1]);
      if (d) sitzung.durchsatzKbit = Math.round(Number(d[1]) / 1000);
      /* Wann diese Werte entstanden sind. Ohne das bleiben sie nach einem
         Fehlschlag von `ss` beliebig lange stehen — unbemerkt, weil nichts
         sie als veraltet kennzeichnet. */
      if (l || d) sitzung.leitungStand = Date.now();
    });
}

/*
 * Wächst der Rückstand gerade?
 *
 * Das ist die ehrlichste Frage, die dieses Programm stellen kann, und die
 * einzige, die ohne Schätzung auskommt. `stauMasse` unten muss die
 * Rohrfüllung aus Laufzeit und Durchsatz RECHNEN — beides kommt aus `ss`,
 * höchstens alle zwei Sekunden, und liegt daneben, wenn die Leitung sich
 * gerade ändert. Der rohe Rückstand dagegen steht alle 200 ms frisch da.
 *
 * Ob er STEIGT beantwortet direkt: läuft mehr hinein als hinaus. Dafür
 * braucht es keine Ahnung davon, wie groß das Rohr ist.
 *
 * Bewusst streng: durchgehend steigend über eine Sekunde UND spürbar
 * gewachsen. Einzelne Ausschläge sind normal — TCP schiebt in Wellen.
 */
const WACHSTUM_MINDEST = 16 * 1024;

function waechstStau(sitzung) {
  const v = sitzung.stauVerlauf;
  if (!v || v.length < 5) return false;
  for (let i = 1; i < v.length; i += 1) if (v[i] <= v[i - 1]) return false;
  return v[v.length - 1] - v[0] > WACHSTUM_MINDEST;
}

/*
 * Rückstau von Rohrfüllung trennen.
 *
 * `unterwegs` ist alles, was noch nicht beim Betrachter ist. Davon ist
 * `rohr` unvermeidlich — es ist die Strecke selbst. Nur was darüber liegt,
 * wartet wirklich irgendwo und kostet zusätzliche Verzögerung.
 */
function stauMasse(sitzung) {
  const unterwegs = sendestau(sitzung) + (sitzung.ws?.bufferedAmount ?? 0);
  const ziel      = sitzung.rateJetzt ?? sitzung.rateMax ?? 2000;
  /* Für die Rohrfüllung zählt, wie schnell die Daten **wirklich** abfließen,
     nicht was wir uns vorgenommen haben. Ein Schreibtisch, der sich kaum
     ändert, braucht die Zielrate gar nicht aus — rechnet man trotzdem mit
     ihr, erscheint das Rohr größer als es ist und echter Rückstau bleibt
     unsichtbar. Genau das war zu sehen: Ziel 6000, tatsächlich 2900, und
     der Rückstand wuchs unbemerkt auf über 300 KB. Deshalb der kleinere
     der beiden Werte. */
  const kbit      = Math.min(ziel, sitzung.durchsatzKbit || ziel);
  const bytesJeS  = kbit * 1000 / 8;
  const rohr      = bytesJeS * ((sitzung.laufzeitMs ?? 0) / 1000);
  const erlaubt   = Math.max(STAU_MINDEST, bytesJeS * STAU_ZEIT_S);
  return { unterwegs, stau: Math.max(0, unterwegs - rohr), erlaubt };
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

  leitungMessen(sitzung);
  const { stau, erlaubt } = stauMasse(sitzung);
  const jetzige = sitzung.rateJetzt ?? sitzung.rateMax;
  let neu = jetzige;

  /* Zwei Wege nach unten, und der zweite ist der schnellere: `stau > erlaubt`
     hängt an Werten, die bis zu zwei Sekunden alt sein können, das Wachstum
     an einer Zahl von vor 200 ms. Wer nur auf den ersten hört, regelt zu spät
     — genau das war an der alten Regelung falsch, nur andersherum. */
  if (stau > erlaubt || waechstStau(sitzung)) {
    neu = Math.round(jetzige * 0.75);          /* Rückstau: deutlich runter */
    /* Verlauf leeren, sonst löst dasselbe Wachstum beim nächsten Durchgang
       ein zweites Mal aus, obwohl schon gedrosselt wurde. */
    sitzung.stauVerlauf = [];
  } else if (stau < erlaubt / 4) {
    /* Der Kern weiß besser als jede Schätzung, was die Leitung trägt — er
       misst es an den Bestätigungen. Solange Luft ist, gehen wir gleich in
       die Nähe dieses Werts, statt uns in 8-%-Schritten heranzutasten: von
       2500 auf 6000 kbit/s wären das elf Schritte, also gut zwanzig
       Sekunden weiches Bild nach jeder Störung. Die 0,95 lassen Abstand,
       damit die Messung nicht ihre eigene Obergrenze bestätigt. */
    const gemessen = sitzung.durchsatzKbit ? Math.round(sitzung.durchsatzKbit * 0.95) : 0;
    neu = Math.max(Math.round(jetzige * 1.08), gemessen);
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
    const { stau, erlaubt } = stauMasse(sitzung);
    /* Auch hier beide Wege. Das Verwerfen ist die letzte Verteidigungslinie;
       sie darf nicht an denselben veralteten Zahlen hängen wie die
       Ratenregelung, sonst fällt bei einer schnellen Verschlechterung beides
       gleichzeitig aus. */
    if ((stau > erlaubt || waechstStau(sitzung)) && !istSchluesselbild(inhalt)) {
      sitzung.verworfen += 1;
      return;                       /* siehe Kopf: verwerfen statt stauen */
    }
    senden(sitzung, N_BILD, inhalt);
    sitzung.bilder += 1;
  } else if (art === H_ABLAGE) {
    senden(sitzung, N_ABLAGE, inhalt);
  } else if (art === H_MELDUNG) {
    sitzung.letzteMeldung = String(inhalt);
    sitzung.verworfenGesamt = (sitzung.verworfenGesamt ?? 0) + sitzung.verworfen;
    /* Bei jeder Meldung mitschreiben — so steht im Zustand immer der Stand
       der letzten zwei Sekunden, ohne eigenen Zeitgeber. */
    zustandSchreiben();
    const mass = stauMasse(sitzung);
    senden(sitzung, N_INFO, Buffer.from(JSON.stringify({
      takt: sitzung.letzteMeldung,
      verworfen: sitzung.verworfen,
      /* `stau` ist jetzt der echte Rückstand ohne Rohrfüllung. `unterwegs`
         steht daneben, sonst wäre auf einer langen Leitung nicht zu sehen,
         wieviel überhaupt in der Luft ist. */
      stau: Math.round(mass.stau),
      unterwegs: mass.unterwegs,
      laufzeit: Math.round(sitzung.laufzeitMs ?? 0),
      durchsatz: sitzung.durchsatzKbit ?? 0,
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
