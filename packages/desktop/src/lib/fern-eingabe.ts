/**
 * Fernsteuerung mit dem Finger — die Umrechnung, ohne DOM.
 *
 * Absichtlich frei von React und Browser-Objekten: so lässt sich jede Geste
 * in scripts/fern-eingabe-pruefen.mjs nachspielen, ohne ein Telefon.
 *
 * Die Zeilen sind die Befehle, die `fern-host` auf dem Pi versteht
 * (server-setup/fernsteuerung/LIESMICH.md, „Von Hand ausprobieren"):
 * `z x y` Zeiger absolut in 0..65535, `t knopf 0|1`, `r achse wert`,
 * `k code 0|1`.
 */

export type Rechteck = { left: number; top: number; width: number; height: number };
export type Punkt = { x: number; y: number };

/** Wo auf dem Pi-Schirm liegt dieser Punkt? `rect` ist das, was
 *  `getBoundingClientRect()` für die Leinwand liefert — samt Zoom, denn die
 *  Umrechnung durch `transform` ist darin schon enthalten. */
export function nachSchirm(x: number, y: number, rect: Rechteck): [number, number] | null {
  if (!rect.width || !rect.height) return null;
  const fx = (x - rect.left) / rect.width;
  const fy = (y - rect.top) / rect.height;
  if (fx < 0 || fx > 1 || fy < 0 || fy > 1) return null;
  return [Math.round(fx * 65535), Math.round(fy * 65535)];
}

/* ── Zoom der Ansicht ────────────────────────────────────────── */

/** `transform: translate(x, y) scale(s)` mit `transform-origin: 0 0`,
 *  bezogen auf die unverschobene Leinwand. */
export type Ansicht = { s: number; x: number; y: number };
export const ANSICHT_GANZ: Ansicht = { s: 1, x: 0, y: 0 };
const S_MAX = 5;

/**
 * Zwei Finger: der Punkt zwischen ihnen bleibt unter den Fingern, der
 * Abstand bestimmt die Vergrößerung. Alle Punkte relativ zur linken oberen
 * Ecke der UNVERSCHOBENEN Leinwand, `w`/`h` deren Größe.
 *
 * Geklemmt so, dass die Leinwand ihren Rahmen immer ganz füllt — kein
 * schwarzer Streifen neben einem vergrößerten Bild, und bei 1 steht sie
 * wieder genau dort, wo sie ohne Zoom stünde.
 */
export function ansichtNachziehen(
  a: Ansicht, w: number, h: number,
  mitteAlt: Punkt, mitteNeu: Punkt, abstandAlt: number, abstandNeu: number,
): Ansicht {
  const faktor = abstandAlt > 0 && abstandNeu > 0 ? abstandNeu / abstandAlt : 1;
  const s = Math.min(S_MAX, Math.max(1, a.s * faktor));
  /* Welcher Punkt der Leinwand lag unter der alten Mitte? Der soll unter der
     neuen liegen. */
  const px = (mitteAlt.x - a.x) / a.s;
  const py = (mitteAlt.y - a.y) / a.s;
  const x = Math.min(0, Math.max(w * (1 - s), mitteNeu.x - s * px));
  const y = Math.min(0, Math.max(h * (1 - s), mitteNeu.y - s * py));
  return { s, x, y };
}

/* ── Gesten ──────────────────────────────────────────────────── */

export interface GestenUmgebung {
  /** Bildschirmpunkt → Pi-Koordinate, `null` außerhalb des Bildes. */
  ort(p: Punkt): [number, number] | null;
  /** Befehlszeilen für den Pi. */
  senden(zeilen: string): void;
  /** Zwei Finger bewegen die Ansicht (Bildschirmkoordinaten). */
  zoomen(mitteAlt: Punkt, mitteNeu: Punkt, abstandAlt: number, abstandNeu: number): void;
  /** Ist gerade vergrößert? Dann verschieben zwei Finger die Ansicht, sonst
   *  rollen sie auf dem Pi. */
  vergroessert(): boolean;
}

/* Schwellen, auf dem Telefon ausprobiert — nicht gemessen, sondern die
   üblichen Werte der Plattformen: iOS wertet ab etwa 10 Punkten als Ziehen,
   ein langes Drücken ab einer halben Sekunde. */
export const ZIEH_SCHWELLE = 10;
export const LANG_MS = 500;
const ZOOM_SCHWELLE = 0.12;       /* 12 % Abstandsänderung = Zoomen, nicht Rollen */
const ROLL_FAKTOR = 0.3;          /* Punkte Fingerweg → Rolleinheiten (15 = eine Raste) */

const LINKS = 272, RECHTS = 273;

type Modus = 'nichts' | 'wartet' | 'ziehen' | 'lang' | 'zwei' | 'zoom' | 'rollen' | 'aus';

function abstand(a: Punkt, b: Punkt): number { return Math.hypot(a.x - b.x, a.y - b.y); }
function mitte(a: Punkt, b: Punkt): Punkt { return { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 }; }

/**
 * Tippen = Klick, Ziehen = Maus ziehen, lange drücken = Rechtsklick,
 * zwei Finger = zoomen, verschieben oder rollen.
 *
 * Der Knopf geht erst hinunter, wenn klar ist, dass gezogen wird — sonst
 * wäre jedes Tippen, das einen Hauch wackelt, ein kleines Ziehen, und aus
 * einem Klick auf einen Ordner würde ein Verschieben.
 */
export class Gesten {
  private finger = new Map<number, Punkt>();
  private modus: Modus = 'nichts';
  private start: Punkt = { x: 0, y: 0 };
  private startZeit = 0;
  private zweiMitte: Punkt = { x: 0, y: 0 };
  private zweiAbstand = 0;
  private zweiAbstandAnfang = 0;
  private zweiMitteAnfang: Punkt = { x: 0, y: 0 };

  constructor(private u: GestenUmgebung) {}

  private klick(p: Punkt, knopf: number): void {
    const o = this.u.ort(p);
    if (o) this.u.senden(`z ${o[0]} ${o[1]}\nt ${knopf} 1\nt ${knopf} 0\n`);
  }

  runter(id: number, p: Punkt, t: number): void {
    this.finger.set(id, p);
    if (this.finger.size === 1) {
      this.modus = 'wartet';
      this.start = p;
      this.startZeit = t;
      return;
    }
    if (this.finger.size === 2) {
      /* Ein zweiter Finger beendet, was der erste angefangen hat — ein
         gedrückter Knopf bliebe sonst auf dem Pi hängen. */
      if (this.modus === 'ziehen') {
        /* Dort loslassen, wo der erste Finger JETZT liegt — am Startpunkt
           hieße, das Gezogene zurückzuschieben. */
        const erster = [...this.finger.entries()].find(([k]) => k !== id)?.[1];
        this.loslassen(erster ?? this.start);
      }
      const [a, b] = [...this.finger.values()];
      this.zweiMitte = this.zweiMitteAnfang = mitte(a, b);
      this.zweiAbstand = this.zweiAbstandAnfang = abstand(a, b);
      this.modus = 'zwei';
      return;
    }
    this.modus = 'aus';                 /* drei Finger: nichts davon */
  }

  bewegt(id: number, p: Punkt, t: number): void {
    if (!this.finger.has(id)) return;
    this.finger.set(id, p);
    if (this.modus === 'wartet' && t - this.startZeit < LANG_MS && abstand(p, this.start) > ZIEH_SCHWELLE) {
      const o = this.u.ort(this.start);
      if (!o) { this.modus = 'aus'; return; }
      this.u.senden(`z ${o[0]} ${o[1]}\nt ${LINKS} 1\n`);
      this.modus = 'ziehen';
    }
    if (this.modus === 'ziehen') {
      const o = this.u.ort(p);
      if (o) this.u.senden(`z ${o[0]} ${o[1]}\n`);
      return;
    }
    if (this.modus === 'zwei' || this.modus === 'zoom' || this.modus === 'rollen') {
      if (this.finger.size !== 2) return;
      const [a, b] = [...this.finger.values()];
      const m = mitte(a, b);
      const d = abstand(a, b);
      if (this.modus === 'zwei') {
        /* Einmal entschieden, gilt es für die ganze Geste — sonst springt
           die Ansicht zwischen Rollen und Zoomen hin und her. */
        if (Math.abs(d / (this.zweiAbstandAnfang || 1) - 1) > ZOOM_SCHWELLE || this.u.vergroessert()) this.modus = 'zoom';
        else if (abstand(m, this.zweiMitteAnfang) > ZIEH_SCHWELLE) this.modus = 'rollen';
      }
      if (this.modus === 'zoom') {
        this.u.zoomen(this.zweiMitte, m, this.zweiAbstand, d);
      } else if (this.modus === 'rollen') {
        /* Natürliche Richtung wie auf dem Telefon: Finger nach oben schiebt
           den Inhalt nach oben, also nach unten rollen. */
        const dy = -(m.y - this.zweiMitte.y) * ROLL_FAKTOR;
        const dx = -(m.x - this.zweiMitte.x) * ROLL_FAKTOR;
        let zeilen = '';
        if (Math.abs(dy) >= 0.01) zeilen += `r 0 ${dy.toFixed(2)}\n`;
        if (Math.abs(dx) >= 0.01) zeilen += `r 1 ${dx.toFixed(2)}\n`;
        if (zeilen) this.u.senden(zeilen);
      }
      this.zweiMitte = m;
      this.zweiAbstand = d;
    }
  }

  hoch(id: number, p: Punkt, t: number, abgebrochen = false): void {
    if (!this.finger.has(id)) return;
    this.finger.delete(id);
    if (this.modus === 'wartet' && !abgebrochen) {
      if (t - this.startZeit >= LANG_MS) this.klick(this.start, RECHTS);
      else this.klick(this.start, LINKS);
    } else if (this.modus === 'ziehen') {
      this.loslassen(p);
    }
    /* Hebt einer von zwei Fingern ab, ist die Geste vorbei — der
       verbleibende darf nicht plötzlich klicken oder ziehen. */
    this.modus = this.finger.size === 0 ? 'nichts' : 'aus';
  }

  /** Vom Zeitgeber der Ansicht nach `LANG_MS` gerufen: lag der Finger so
   *  lange still, ist es ein Rechtsklick — schon jetzt, nicht erst beim
   *  Loslassen, damit das Kontextmenü unter dem Finger aufgeht. */
  zeit(t: number): void {
    if (this.modus !== 'wartet' || t - this.startZeit < LANG_MS) return;
    this.klick(this.start, RECHTS);
    this.modus = 'lang';
  }

  private loslassen(p: Punkt): void {
    const o = this.u.ort(p);
    this.u.senden(o ? `z ${o[0]} ${o[1]}\nt ${LINKS} 0\n` : `t ${LINKS} 0\n`);
  }
}

/* ── Bildschirmtastatur ──────────────────────────────────────── */

/*
 * Zeichen → evdev-Codes. Der Pi hat die Belegung „us" geladen
 * (host/eingabe.c), also gelten deren Plätze — ein „z" liegt dort auf KEY_Z
 * (44), nicht wie auf einer deutschen Tastatur auf KEY_Y.
 */
const UNGESHIFTET = 'abcdefghijklmnopqrstuvwxyz1234567890 -=[]\\;\'`,./\n\t';
const GESHIFTET   = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ!@#$%^&*() _+{}|:"~<>?';
const CODES = [
  30, 48, 46, 32, 18, 33, 34, 35, 23, 36, 37, 38, 50, 49, 24, 25, 16, 19, 31, 20, 22, 47, 17, 45, 21, 44,
  2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 57, 12, 13, 26, 27, 43, 39, 40, 41, 51, 52, 53, 28, 15,
];
const SHIFT = 42;

/** Sondertasten nach `KeyboardEvent.key` — die iOS-Tastatur liefert dort
 *  verlässliche Namen, `code` bleibt bei ihr oft leer. */
export const SONDERTASTEN: Record<string, number> = {
  Backspace: 14, Enter: 28, Tab: 15, Escape: 1, Delete: 111,
  ArrowUp: 103, ArrowDown: 108, ArrowLeft: 105, ArrowRight: 106,
  Home: 102, End: 107, PageUp: 104, PageDown: 109,
};

export function taste(code: number): string { return `k ${code} 1\nk ${code} 0\n`; }

/**
 * Text als Tastendrücke. `null`, sobald ein Zeichen darin auf der
 * US-Belegung nicht vorkommt (ä, ß, Emoji …) — dann geht der Text über die
 * Zwischenablage und Strg+V, siehe `EINFUEGEN`.
 *
 * Typografische Anführungszeichen, die iOS beim Tippen von selbst setzt,
 * werden zu geraden: wer im Terminal `'` tippt, meint `'`.
 */
export function textNachTasten(text: string): string | null {
  const glatt = text.replace(/[‘’]/g, "'").replace(/[“”]/g, '"').replace(/\r\n?/g, '\n');
  let zeilen = '';
  for (const z of glatt) {
    const u = UNGESHIFTET.indexOf(z);
    if (u >= 0) { zeilen += taste(CODES[u]); continue; }
    const g = GESHIFTET.indexOf(z);
    if (g >= 0 && z !== ' ') { zeilen += `k ${SHIFT} 1\n${taste(CODES[g])}k ${SHIFT} 0\n`; continue; }
    return null;
  }
  return zeilen;
}

/** Strg+V — nach dem Setzen der Ablage des Pi. */
export const EINFUEGEN = `k 29 1\n${taste(47)}k 29 0\n`;

/**
 * Befehlszeilen in Nachrichten aufteilen, die der Chat-Server annimmt
 * (unter 4096 Zeichen, siehe `eingabeGueltig` in fernleitung.ts). Ohne das
 * ging ein eingefügter Absatz ab etwa 170 Zeichen komplett verloren — jede
 * Taste sind zwei, mit Umschalt vier Zeilen. Geschnitten wird nur an
 * Zeilenenden, damit jedes Stück für sich gültig bleibt.
 */
export function inStuecke(zeilen: string, max = 3500): string[] {
  const stuecke: string[] = [];
  let jetzt = '';
  for (const z of zeilen.split('\n')) {
    if (!z) continue;
    if (jetzt && jetzt.length + z.length + 1 > max) { stuecke.push(jetzt); jetzt = ''; }
    jetzt += `${z}\n`;
  }
  if (jetzt) stuecke.push(jetzt);
  return stuecke;
}

/** Zeichen je Ablage-Runde. Der Server nimmt höchstens 6000 BYTES an
 *  (ABLAGE_MAX in fernleitung.ts); ein Zeichen hat in UTF-8 bis zu vier,
 *  also 1500. Längerer Text geht in mehreren Runden Ablage + Strg+V. */
export const ABLAGE_STUECK = 1500;

/*
 * Wie lange zwischen zwei Ablage-Runden gewartet wird. Strg+V holt die
 * Ablage auf dem Pi ASYNCHRON ab — kommt die nächste Runde zu früh, fügt die
 * Anwendung schon deren Text ein, und die Stücke überholen sich.
 */
export const ABLAGE_PAUSE_MS = 150;

/** Text über die Ablage des Pi und Strg+V, in Runden mit Pause dazwischen. */
export async function ablageRunden(
  text: string, ablage: (t: string) => void, schick: (z: string) => void,
  warte: (ms: number) => Promise<void> = (ms) => new Promise((r) => setTimeout(r, ms)),
): Promise<void> {
  const zeichen = Array.from(text);
  for (let i = 0; i < zeichen.length; i += ABLAGE_STUECK) {
    if (i) await warte(ABLAGE_PAUSE_MS);
    ablage(zeichen.slice(i, i + ABLAGE_STUECK).join(''));
    schick(EINFUEGEN);
  }
}
