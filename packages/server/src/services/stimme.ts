import { config } from '../config.js';

/**
 * Sprache zu Text — auf der eigenen Maschine.
 *
 * Nebenan läuft whisper.cpp als kleiner HTTP-Dienst. Er nimmt eine Aufnahme
 * entgegen und gibt dieselbe Antwort zurück, die auch Groq schickt: Text,
 * erkannte Sprache, Dauer. Genau deshalb steht hier so wenig — die Auswertung
 * in voice.ts ist für beide Wege dieselbe.
 *
 * Zwei Dinge macht diese Datei, die ein reiner HTTP-Aufruf nicht macht:
 *
 *  1. **Nachsehen, ob überhaupt jemand da ist.** Der Dienst kann fehlen, gerade
 *     starten oder sein Modell noch laden. Ohne diese Prüfung liefe jede
 *     Sprachnachricht in eine Zeitüberschreitung, und die Oberfläche zeigte
 *     minutenlang „wird transkribiert" für etwas, das nie kommt.
 *
 *  2. **Nacheinander statt gleichzeitig.** whisper.cpp rechnet ohnehin nur eine
 *     Aufnahme auf einmal und nimmt sich dafür fast den ganzen Rechner. Kämen
 *     drei Aufnahmen zugleich an, würden sie sich im Dienst gegenseitig
 *     ausbremsen und nebenbei den Chat mitreißen. Die Reihe steht deshalb hier,
 *     wo sie sichtbar ist, und hat eine Obergrenze.
 */

export class StimmeNichtDa extends Error {}

export interface Abschrift {
  text: string;
  /** Wie Whisper die Sprache nennt — „german", nicht „de". */
  sprache: string | undefined;
  /** Länge der Aufnahme in Sekunden, wie der Dienst sie gemessen hat. */
  sekunden: number | undefined;
}

/* ── Ist der Dienst da? ───────────────────────────────────────── */

/**
 * Das Ergebnis wird kurz gemerkt.
 *
 * Ein Nein hält nur wenige Sekunden: startet der Dienst gerade neu, soll die
 * nächste Sprachnachricht ihn wieder finden und nicht eine Minute lang in
 * einem veralteten „nicht da" hängen. Ein Ja hält länger, denn dann ist der
 * teure Weg ohnehin der Aufruf danach.
 */
let gemerkt: { da: boolean; bis: number } = { da: false, bis: 0 };
const MERKEN_JA = 60_000;
const MERKEN_NEIN = 5_000;

function adresse(): string {
  return config.ai.stimme.baseUrl.replace(/\/+$/, '');
}

/** Eingerichtet heißt: eine Adresse steht da. Nicht, dass dort jemand antwortet. */
export function eingerichtet(): boolean {
  return Boolean(adresse());
}

/**
 * Antwortet der Dienst und hat er sein Modell geladen?
 *
 * whisper.cpp meldet 503 mit „loading model", solange die Gewichte von der
 * Platte kommen. Das ist kein Fehler, sondern ein Später — nur eben nicht
 * jetzt, und für die Sprachnachricht, die gerade ankommt, ist das dasselbe.
 */
export async function erreichbar(frisch = false): Promise<boolean> {
  if (!eingerichtet()) return false;
  if (!frisch && Date.now() < gemerkt.bis) return gemerkt.da;

  let da = false;
  try {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 2500);
    try {
      const res = await fetch(`${adresse()}/health`, { signal: ctrl.signal });
      da = res.ok;
    } finally {
      clearTimeout(timer);
    }
  } catch {
    da = false;
  }

  gemerkt = { da, bis: Date.now() + (da ? MERKEN_JA : MERKEN_NEIN) };
  return da;
}

/** Nach einem Fehlschlag nicht auf die gemerkte Antwort vertrauen. */
function vergessen(): void {
  gemerkt = { da: false, bis: 0 };
}

/**
 * Der zuletzt bekannte Stand, ohne zu fragen.
 *
 * Für alles, was sofort antworten muss: die Fähigkeitenliste in
 * `/api/health`, die Anzeige in den Einstellungen. Wer wirklich abtippen
 * will, ruft `erreichbar()` und wartet die Antwort ab.
 */
export function bekanntErreichbar(): boolean {
  return gemerkt.da;
}

/**
 * Regelmäßig nachsehen, ob der Dienst da ist.
 *
 * Ohne das stünde in den Einstellungen der Stand vom letzten Aufruf: startet
 * der Sprachdienst nach dem Chat-Server, bliebe dort „nicht verfügbar", bis
 * zufällig jemand eine Sprachnachricht schickt. Das Nachsehen kostet eine
 * HTTP-Anfrage an 127.0.0.1 und ist deshalb billiger als die Verwirrung.
 */
export function beobachten(abstand = 30_000): void {
  void erreichbar(true);
  const uhr = setInterval(() => { void erreichbar(true); }, abstand);
  // Der Takt darf den Server nicht am Beenden hindern.
  uhr.unref?.();
}

/* ── Einer nach dem anderen ───────────────────────────────────── */

let laufend: Promise<unknown> = Promise.resolve();
let wartend = 0;

/** Wie viele Aufnahmen gerade anstehen — für die Anzeige und für Prüfungen. */
export function schlange(): number {
  return wartend;
}

function anstellen<T>(arbeit: () => Promise<T>): Promise<T> {
  if (wartend >= config.ai.stimme.warteschlange) {
    return Promise.reject(new StimmeNichtDa(
      `zu viele Aufnahmen in der Warteschlange (${wartend})`,
    ));
  }
  wartend += 1;
  /* An die laufende Kette hängen, nicht an ihr Ergebnis: ein Fehler in der
     Aufnahme davor darf die dahinter nicht mitreißen. */
  const dran = laufend.then(arbeit, arbeit);
  laufend = dran.catch(() => { /* die Kette läuft weiter */ });
  return dran.finally(() => { wartend -= 1; });
}

/* ── Abtippen ─────────────────────────────────────────────────── */

/**
 * Eine Aufnahme abtippen lassen.
 *
 * Die Datei geht so hinüber, wie sie hochgeladen wurde — webm, mp4, ogg. Der
 * Dienst wird mit `--convert` gestartet und schickt sie durch ffmpeg, bevor er
 * rechnet. Das gehört bewusst dorthin und nicht hierher: sonst läge auf dem
 * Chat-Server eine zweite Kopie jeder Aufnahme, und ffmpeg müsste überall
 * dort vorhanden sein, wo Stellium läuft.
 */
export async function abtippen(input: {
  bytes: Buffer; mime: string; name: string;
}): Promise<Abschrift> {
  if (!await erreichbar()) {
    throw new StimmeNichtDa(`kein Sprachdienst unter ${adresse()}`);
  }

  return anstellen(async () => {
    const form = new FormData();
    form.append('file', new Blob([input.bytes], { type: input.mime || 'audio/webm' }), input.name || 'aufnahme.webm');
    // Dieselbe Antwortform wie bei Groq: Text, Sprache, Dauer in einem Stück.
    form.append('response_format', 'verbose_json');
    form.append('temperature', '0');
    // "auto" — der Dienst soll die Sprache erkennen, nicht raten.
    form.append('language', 'auto');

    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), config.ai.stimme.timeoutMs);
    try {
      const res = await fetch(`${adresse()}/inference`, {
        method: 'POST', body: form, signal: ctrl.signal,
      });
      if (!res.ok) {
        vergessen();
        throw new StimmeNichtDa(`${res.status} ${(await res.text()).slice(0, 200)}`);
      }
      const data = await res.json() as { text?: string; language?: string; duration?: number };
      return {
        text: (data.text ?? '').trim(),
        sprache: data.language,
        sekunden: typeof data.duration === 'number' ? data.duration : undefined,
      };
    } catch (err) {
      if (err instanceof StimmeNichtDa) throw err;
      vergessen();
      if ((err as Error).name === 'AbortError') throw new StimmeNichtDa('Zeitüberschreitung');
      throw new StimmeNichtDa((err as Error).message);
    } finally {
      clearTimeout(timer);
    }
  });
}
