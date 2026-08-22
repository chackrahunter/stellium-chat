import { LANGUAGES, languageInfo } from '@stellium/shared';
import { currentUiLanguage, t } from '../i18n/index.js';

export { LANGUAGES, languageInfo };

/**
 * Datum, Uhrzeit und Zeitspannen in der Sprache der Oberfläche.
 *
 * Vorher stand hier überall 'de-DE' fest. Wer Stellium auf Englisch las, bekam
 * trotzdem "Donnerstag" und "vor 3 Stunden" — die Übersetzung endete an der
 * ersten Zahl.
 */
function sprache(): string {
  return currentUiLanguage();
}

export function timeOfDay(ts: number, timezone?: string): string {
  return new Intl.DateTimeFormat(sprache(), {
    hour: '2-digit', minute: '2-digit',
    ...(timezone ? { timeZone: timezone } : {}),
  }).format(ts);
}

/**
 * Uhrzeit aus Sicht einer anderen Person — für Lesebestätigungen.
 *
 * Anders als timeOfDay() (das immer in der eigenen Oberflächensprache
 * formatiert) gehören Sprache UND Zeitzone hier der Person, über die die
 * Auskunft geht, nicht der Person, die gerade hinschaut. „Um 14:32 gelesen"
 * ist eine Aussage über den Moment eines anderen Menschen — sie in der
 * eigenen Zeitzone auszugeben wäre keine Übersetzung, sondern eine andere
 * Behauptung.
 *
 * Genau das tat aber `timeZone: timezone || undefined` bei einer leeren
 * Zeitzone: Intl.DateTimeFormat behandelt eine LEERE Zeichenkette als
 * ungültig und wirft — `undefined` dagegen gilt ihm als "nicht angegeben"
 * und wird kommentarlos durch die Zeitzone DIESES Rechners ersetzt. Der
 * catch-Zweig hatte denselben Fehler: er ließ `timeZone` einfach weg, statt
 * ehrlich zu sagen, dass die Zeitzone der anderen Person nicht bekannt ist.
 * Beides zusammen führte genau zu dem Bild, das diese Funktion laut eigenem
 * Kommentar verhindern soll — nur eine Ebene tiefer als bei localTimeFor()
 * unten. Jetzt: eine leere/ungültige Zeitzone bekommt UTC, ausdrücklich als
 * solche beschriftet (timeZoneName) — nie die Zeitzone des Betrachters unter
 * fremdem Namen. UTC statt eines Rückfalls auf den Rechner, weil UTC
 * niemandes private Ortszeit ist und deshalb nicht mit einer echten
 * verwechselt werden kann; derselbe Gedanke steht schon in
 * services/push.ts (`timeZone: timezone || 'UTC'`).
 */
export function zeitAusSicht(ts: number, language: string, timezone: string): string {
  if (timezone) {
    try {
      return new Intl.DateTimeFormat(language || 'en', {
        hour: '2-digit', minute: '2-digit', timeZone: timezone,
      }).format(ts);
    } catch {
      // Ungültiger Zeitzonenname — weiter unten dieselbe ehrliche Notlösung
      // wie beim leeren Fall.
    }
  }
  return new Intl.DateTimeFormat(language || 'en', {
    hour: '2-digit', minute: '2-digit', timeZone: 'UTC', timeZoneName: 'short',
  }).format(ts);
}

export function dayLabel(ts: number): string {
  const date = new Date(ts);
  const today = new Date();
  const startOf = (d: Date) => new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
  const diffDays = Math.round((startOf(date) - startOf(today)) / 86_400_000);
  if (diffDays === 0) return t('zeit.heute');
  if (diffDays === -1) return t('zeit.gestern');
  if (diffDays > -7) return new Intl.DateTimeFormat(sprache(), { weekday: 'long' }).format(date);
  return new Intl.DateTimeFormat(sprache(), {
    day: 'numeric', month: 'long',
    year: date.getFullYear() === today.getFullYear() ? undefined : 'numeric',
  }).format(date);
}

export function relativeTime(ts: number): string {
  const rtf = new Intl.RelativeTimeFormat(sprache(), { numeric: 'auto' });
  const seconds = Math.round((ts - Date.now()) / 1000);
  const abs = Math.abs(seconds);
  if (abs < 60) return rtf.format(Math.round(seconds), 'second');
  if (abs < 3600) return rtf.format(Math.round(seconds / 60), 'minute');
  if (abs < 86_400) return rtf.format(Math.round(seconds / 3600), 'hour');
  return rtf.format(Math.round(seconds / 86_400), 'day');
}

/** Datum und Uhrzeit zusammen — für Verläufe und Termine. */
export function dateTime(ts: number): string {
  return new Intl.DateTimeFormat(sprache(), { dateStyle: 'medium', timeStyle: 'short' }).format(ts);
}

export function sameDay(a: number, b: number): boolean {
  const x = new Date(a); const y = new Date(b);
  return x.getFullYear() === y.getFullYear() && x.getMonth() === y.getMonth() && x.getDate() === y.getDate();
}

/** Restzeit knapp: "12 s", "3:20". Über eine Stunde interessiert die Zahl nicht mehr. */
export function restzeit(sekunden: number): string {
  if (!Number.isFinite(sekunden) || sekunden <= 0) return '';
  /* "> 1 h" statt eines Satzes: die Einheit muss trotzdem durch Intl, sonst
     steht "h" fest da, wo Russisch "ч" und Japanisch "時間" bräuchte. Das
     ">" bleibt ein Zeichen — dafür gibt es keine Übersetzung, genau wie "%"
     an anderer Stelle im Haus. */
  if (sekunden > 3600) {
    return `> ${new Intl.NumberFormat(sprache(), { style: 'unit', unit: 'hour', unitDisplay: 'narrow' }).format(1)}`;
  }
  if (sekunden < 60) {
    return new Intl.NumberFormat(sprache(), { style: 'unit', unit: 'second', unitDisplay: 'narrow' }).format(Math.round(sekunden));
  }
  const min = Math.floor(sekunden / 60);
  const sek = Math.round(sekunden % 60);
  return `${min}:${String(sek).padStart(2, '0')}`;
}

/* Bis Terabyte, nicht nur bis Gigabyte: SystemPanel zeigt Werte, die über die
   Lebenszeit eines Servers durchaus dort ankommen (Datenbankgröße, insgesamt
   übertragen). Eine Nachkommastelle nur unterhalb von 10 in der jeweiligen
   Einheit — "42 GB" statt "42,0 GB", aber "9,2 GB" bleibt genau. */
const GROESSEN_EINHEITEN = ['byte', 'kilobyte', 'megabyte', 'gigabyte', 'terabyte'] as const;

/** Dateigröße lesbar: "512 Byte", "480 kB", "1,5 MB" — Einheit und
 *  Dezimaltrennzeichen kommen aus Intl, nicht aus eigenen Tabellen. */
export function fileSize(bytes: number): string {
  let i = 0; let wert = bytes;
  while (wert >= 1024 && i < GROESSEN_EINHEITEN.length - 1) { wert /= 1024; i++; }
  return new Intl.NumberFormat(sprache(), {
    style: 'unit', unit: GROESSEN_EINHEITEN[i], unitDisplay: 'short',
    maximumFractionDigits: i > 0 && wert < 10 ? 1 : 0,
  }).format(wert);
}

export function initials(name: string): string {
  const parts = name.trim().split(/\s+/).slice(0, 2);
  // toLocaleUpperCase statt toUpperCase: in der Türkei wird aus "i" sonst
  // ein punktloses "I" statt des richtigen "İ".
  return parts.map((p) => [...p][0] ?? '').join('').toLocaleUpperCase(sprache()) || '?';
}

/**
 * Zähler mit Deckel: "99+" — mit Ziffern der Oberflächensprache (arabisch-
 * indische in ar, Devanagari in hi). Das Pluszeichen bleibt ein literales
 * Zeichen; dafür gibt es keine Intl-Übersetzung, nur ein Zahlenformat. Die
 * Seite, auf der es im Rechts-nach-links-Satz landet, klärt <bdi> an der
 * Aufrufstelle — reine Zahlenformatierung kann die Umgebung nicht isolieren,
 * genau dafür ist <bdi> gebaut.
 */
export function counterLabel(n: number, deckel = 99): string {
  const formatiert = new Intl.NumberFormat(sprache()).format(Math.min(n, deckel));
  return n > deckel ? `${formatiert}+` : formatiert;
}

/**
 * Ortszeit eines Kollegen — hilft bei verteilten Teams.
 *
 * Fehlt `timezone` (undefined/null/'') oder ist der Wert kein gültiger
 * IANA-Name, darf hier NIE die Zeitzone dieses Rechners einspringen: das
 * wäre die Zeit des Betrachters unter dem Namen einer anderen Person — bei
 * Kolleg:innen in einer anderen Zeitzone im schlimmsten Fall ein Anruf um
 * vier Uhr morgens im Glauben, es sei bei ihnen Nachmittag. Deshalb die
 * eigene Prüfung ganz oben: `timeZone: timezone` wirft bei einer LEEREN
 * Zeichenkette zuverlässig (Intl.DateTimeFormat lässt '' als Zeitzone nicht
 * gelten), aber bei `undefined` NICHT — Intl behandelt das als "keine
 * Zeitzone angegeben" und nimmt still die des Rechners. Ohne diese
 * Vorabprüfung hinge das beobachtbare Verhalten also vom Zufall ab, ob
 * `user.timezone` bei einem kaputten Konto '' oder undefined ist. Ein
 * ungültiger, aber nicht-leerer Name (Tippfehler, alte Kürzel) fällt weiter
 * unten ins catch{} und landet auf demselben leeren Ergebnis.
 *
 * Ein leeres Ergebnis heißt für alle Aufrufer (ProfileCard, Sidebar,
 * ChannelHeader, CalendarPanel, Panels): Feld ausblenden bzw. `time` bleibt
 * leer — nie eine erfundene Uhrzeit anzeigen.
 */
export function localTimeFor(timezone: string | null | undefined): { time: string; offHours: boolean } {
  if (!timezone) return { time: '', offHours: false };
  try {
    const time = new Intl.DateTimeFormat(sprache(), { hour: '2-digit', minute: '2-digit', timeZone: timezone }).format(Date.now());
    const hour = Number(new Intl.DateTimeFormat('en-GB', { hour: '2-digit', hour12: false, timeZone: timezone }).format(Date.now()));
    return { time, offHours: hour < 8 || hour >= 19 };
  } catch {
    // Ungültiger Zeitzonenname — dieselbe Notlösung wie beim leeren Fall
    // oben: lieber nichts zeigen als die Rechnerzeit unter fremdem Namen.
    return { time: '', offHours: false };
  }
}

export function clsx(...parts: (string | false | null | undefined)[]): string {
  return parts.filter(Boolean).join(' ');
}

/**
 * Angezeigter Name eines Kanals — übersetzt, falls vorhanden.
 *
 * Der technische Name bleibt davon unberührt: Erwähnungen wie #vertrieb
 * müssen für alle dieselben sein, sonst zeigt ein Verweis ins Leere.
 */
export function kanalName(channel: { name: string; translation?: { name: string | null } | null }): string {
  return channel.translation?.name || channel.name;
}

/** Thema eines Kanals in der Lesesprache. */
export function kanalThema(channel: { topic: string | null; translation?: { topic: string | null } | null }): string | null {
  return channel.translation?.topic || channel.topic;
}

/**
 * Ein Geldbetrag in Cent — lesbar, in der Sprache der Oberfläche.
 *
 * Vorher stand diese Funktion einzeln in SystemPanel.tsx, mit dem Kommentar
 * "dieselbe Funktion wie überall sonst in der App, nur einmal richtig
 * gemacht — nur eben nicht hier". Jetzt ist sie hier: die Verkaufskachel UND
 * ihre ausführliche Ansicht (VerkaufDetailPanel.tsx) brauchen dieselbe
 * Formatierung, und eine zweite, leicht andere Kopie wäre irgendwann eine
 * Stelle, an der 25,00 $ und $25.00 für denselben Betrag nebeneinander
 * ständen. Die Sprache ist die der Oberfläche, nicht die des Servers.
 */
export function geld(cent: number | null | undefined, waehrung: string | null | undefined): string {
  if (cent === null || cent === undefined || !Number.isFinite(cent)) return '—';
  try {
    return new Intl.NumberFormat(sprache(), { style: 'currency', currency: waehrung || 'USD' }).format(cent / 100);
  } catch {
    /* Unbekanntes Kürzel: lieber die nackte Zahl als gar nichts. */
    return `${(cent / 100).toFixed(2)} ${waehrung ?? ''}`.trim();
  }
}

/** „1 Woche" statt „week: 1" — Intl kennt Tag, Woche, Monat und Jahr in
 *  jeder Sprache, die hier vorkommt. `lang: 'short'` für „30 Tage" statt
 *  „30 Tage" ausgeschrieben in engen Tabellenzeilen. */
export function zeitspanne(anzahl: number | null | undefined, einheit: string | null | undefined,
                            lang: 'long' | 'short' = 'long'): string {
  if (!anzahl || !einheit) return '—';
  try {
    return new Intl.NumberFormat(sprache(), { style: 'unit', unit: einheit, unitDisplay: lang }).format(anzahl);
  } catch {
    return `${anzahl} ${einheit}`;
  }
}

/** Ein Anteil als Prozentzahl — "12,3 %" statt eines von Hand
 *  zusammengesetzten Strings mit fest verdrahtetem Punkt oder Komma. */
export function prozent(anteil: number | null | undefined, nachkomma = 1): string {
  if (anteil === null || anteil === undefined || !Number.isFinite(anteil)) return '—';
  return new Intl.NumberFormat(sprache(), {
    style: 'percent', minimumFractionDigits: nachkomma, maximumFractionDigits: nachkomma,
  }).format(anteil);
}
