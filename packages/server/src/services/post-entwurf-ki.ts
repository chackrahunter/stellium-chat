/**
 * Ein Mailentwurf auf Knopfdruck — für einen Menschen, der gerade selbst
 * schreibt, nicht für die automatische Sichtung.
 *
 * Unterschied zu post-sichtung.ts: DORT schreibt die KI von selbst, sobald
 * Post eintrifft — ein Hintergrundlauf, der einen Entwurf in `mail_entwuerfe`
 * ablegt, den ein Mensch später freigibt oder ablehnt. HIER drückt ein
 * Mensch, der gerade im Antwortfeld oder im Schreibfenster sitzt, auf
 * „KI schreibt" und bekommt sofort einen Vorschlag ins Textfeld — nichts wird
 * in einer Tabelle abgelegt, nichts wird gemeldet, und nichts wird versendet.
 *
 * **Warum keine Funktion aus post-sichtung.ts importiert wird:** die Datei
 * ist gerade gesperrt (an ihr arbeitet ein anderer Auftrag), und die
 * Bausteine, die diese Datei bräuchte (`modellFragen()`, `anweisungMitSprache()`,
 * `kennzeichnungSichern()`), sind dort nicht exportiert. Diese Datei baut sie
 * deshalb aus denselben ÖFFENTLICHEN Bausteinen neu zusammen, die
 * post-sichtung.ts selbst auch verwendet — `anweisungFuerFach()` und
 * `mailAlsEingabe()` aus post-ki.ts unverändert, dieselbe Fensterrechnung aus
 * translation/fenster.ts, dieselbe Fehlereinordnung aus translation/fehler.ts
 * (die post-sichtung.ts selbst NICHT nutzt — ihre eigene Fehlerbehandlung ist
 * schwächer, siehe unten). Für den Antwort-Fall (`modus: 'antwort'`) ist die
 * Anweisung sogar wortgleich mit der von post-sichtung.ts: `anweisungFuerFach()`
 * unverändert aufgerufen, dieselbe Anfrage- und Antwortform (das volle
 * Sichtungs-JSON, aus dem nur `entwurf` gelesen wird). Das ist keine zweite,
 * abweichende KI-Anbindung, sondern derselbe Weg für einen zweiten Anlass.
 * Für den Fall ohne Ursprungsmail (`modus: 'neu'`) gibt es in post-ki.ts
 * keine passende Vorlage — dafür steht unten eine eigene, kurze Anweisung,
 * die dieselbe Kennzeichnung (KENNZEICHNUNG_DE/EN) und dasselbe „nichts
 * erfinden" verlangt wie der Rest des Hauses (vergleiche TEIL_ANWEISUNG in
 * services/ai.ts).
 *
 * **Die KI sendet nie.** Nachprüfbar wie in post-sichtung.ts: `post.js` ist
 * hier nur für `nachricht`, `spracheFuer` und `nurAdresse` eingebunden,
 * `senden` steht nicht im Import. Was nicht eingebunden ist, kann nicht
 * aufgerufen werden. Der Rückgabewert dieser Datei ist ein Textvorschlag,
 * kein Versand — den Knopf „Senden" bedient in jeder Oberfläche weiterhin
 * ausschließlich ein Mensch mit dem Recht `mail.senden`.
 *
 * **Warum kein Fehlschlag ohne Grund:** jede Anfrage an das Modell läuft
 * durch `mitKennung()` (translation/fehler.ts) — dieselbe Stelle, durch die
 * auch services/ai.ts, services/assistant.ts und services/emoji-vorschlaege.ts
 * gehen. Ein nicht erreichbares, überlastetes oder zu langsames Modell liefert
 * dadurch eine eigene, übersetzte Kennung (`fehler.kiUnerreichbar` und
 * Ähnliche) statt der pauschalen „Die KI konnte das gerade nicht erledigen".
 */
import { languageInfo } from '@stellium/shared';
import { Abweisung, abweisung } from '../util/abweisung.js';
import { mitKennung } from '../translation/fehler.js';
import { assistant as kiAnbieter } from '../translation/index.js';
import {
  fensterFuer, fensterVerkleinern, markenSchaetzung, verlaufsBudget,
} from '../translation/fenster.js';
import {
  anweisungFuerFach, mailAlsEingabe, KENNZEICHNUNG_DE, KENNZEICHNUNG_EN,
  type EingehendeMailFuerKi,
} from './post-ki.js';
import { FAECHER, nachricht, spracheFuer, nurAdresse } from './post.js';

/* ── Stellschrauben ───────────────────────────────────────────────
   Dieselben Größenordnungen wie in post-sichtung.ts: hier steht ein ganzer
   Brief drin, nicht nur ein Titel. */
const ANTWORT_MARKEN = 900;
/** Wie viel Mailtext dem Modell höchstens gezeigt wird, bevor gekürzt wird. */
const TEXT_GRENZE = 6000;
/** Wie lang der Vorschlag selbst werden darf. */
const ENTWURF_MAX = 8000;
/** Wie lang die Themenangabe für eine neue Mail werden darf. */
const THEMA_MAX = 2000;

export type EntwurfSchreibenInput =
  | { modus: 'antwort'; mailId: string }
  | { modus: 'neu'; fach: string; an: string; thema: string };

export interface EntwurfSchreibenErgebnis {
  /** Der vollständige Text, mit Unterschrift und Kennzeichnung — fertig fürs Textfeld. */
  text: string;
  /** In welcher Sprache geschrieben wurde. */
  sprache: string;
  /** Welches Modell geantwortet hat, für die Anzeige. */
  modell: string | null;
  /**
   * Der genaue Wortlaut der Kennzeichnung, bytegleich wie er in `text` steht.
   *
   * Für die Oberfläche: bearbeitet ein Mensch den Text danach frei und
   * entfernt dabei diesen Wortlaut, lässt sich das an dieser Zeichenkette
   * erkennen — ohne sie müsste die Oberfläche raten, ob „von Hand gekürzt"
   * oder „Kennzeichnung verschwunden" vorliegt.
   */
  kennzeichnung: string;
}

/* ── Das Modell fragen ────────────────────────────────────────────
   Derselbe Aufbau wie modellFragen() in post-sichtung.ts und
   vorschlaegeAusVerlauf() in services/ai.ts: eine Absage wegen Länge
   (art === 'zuLang') schrumpft das gemerkte Fenster und versucht es noch
   einmal, alles andere fliegt durch — zu `mitKennung()` außen herum, das den
   letzten Fehlschlag in eine übersetzbare Kennung verwandelt. */
async function modellFragenRoh<T>(system: string, user: string): Promise<{ data: T; modell: string | null }> {
  const ai = kiAnbieter();
  if (!ai) {
    throw abweisung('post.kiNichtEingerichtet', 'Die KI ist für diesen Server nicht eingerichtet.');
  }

  return mitKennung(async () => {
    let fenster = fensterFuer(ai.kennung, ai.kontextfenster());
    for (;;) {
      const budget = verlaufsBudget({ fenster, fest: system, antwort: ANTWORT_MARKEN });
      if (budget <= 0 || markenSchaetzung(user) > budget) {
        throw abweisung('post.kiFensterZuKlein',
          `Das Kontextfenster des Modells (${fenster} Marken) reicht für diese Anfrage nicht aus.`);
      }
      try {
        const data = await ai.json<T>([
          { role: 'system', content: system },
          { role: 'user', content: user },
        ], { temperature: 0.3, maxTokens: ANTWORT_MARKEN, reasoning: 'low' });
        return { data, modell: ai.letzterVerbrauch()?.modell ?? ai.kennung };
      } catch (err) {
        // Ein eigener Wurf von oben (etwa post.kiFensterZuKlein) ist kein
        // Anbieterfehler und hat kein `art` — der folgt sofort durch.
        if (err instanceof Abweisung) throw err;
        if ((err as { art?: string }).art !== 'zuLang') throw err;
        const kleiner = fensterVerkleinern(ai.kennung, fenster);
        if (!kleiner) throw err;
        fenster = kleiner;
      }
    }
  });
}

/* ── Die Kennzeichnung ─────────────────────────────────────────────
   Einfacher als kennzeichnungSichern() in post-sichtung.ts (die auch eine
   bloße Erwähnung von "StelliumAI" in einer dritten Sprache gelten lässt):
   hier MUSS der Wortlaut bytegleich mit dem sein, was `kennzeichnung` im
   Ergebnis zurückgibt, weil die Oberfläche genau danach sucht (siehe
   EntwurfSchreibenErgebnis.kennzeichnung oben). Deutsch bekommt den
   deutschen Satz, jede andere Sprache — auch Englisch — den englischen. */
function kennzeichnungFuer(sprache: string): string {
  return sprache === 'de' ? KENNZEICHNUNG_DE : KENNZEICHNUNG_EN;
}

function kennzeichnungSichern(text: string, sprache: string): string {
  const marke = kennzeichnungFuer(sprache);
  const rumpf = text.trimEnd();
  return rumpf.includes(marke) ? rumpf : `${rumpf}\n\n${marke}`;
}

function kuerzen(text: string): string {
  const sauber = text.trim();
  if (!sauber) return '[Diese Nachricht hat keinen Textteil.]';
  return sauber.length > TEXT_GRENZE ? `${sauber.slice(0, TEXT_GRENZE)}\n[… gekürzt]` : sauber;
}

/**
 * "Stellium Support Team" aus "support" — mechanisch aus den acht Fächern
 * abgeleitet, statt aus den Text-Anweisungen in post-ki.ts herausgelöst: dort
 * stehen die Unterschriften nur eingebettet in mehrzeilige, fachspezifische
 * Anweisungsblöcke (siehe SUPPORT_ANWEISUNG & Co.), aus denen sich eine
 * einzelne Zeile nicht sauber herausschälen lässt, ohne diese Datei doch
 * anzufassen. Alle acht folgen exakt diesem Muster ("Stellium X Team"); für
 * ein unbekanntes Fach bleibt es beim neutralen "Stellium Team".
 */
function teamName(fach: string): string {
  const lokal = fach.trim().toLowerCase().split('@')[0].split('+')[0];
  if (!(FAECHER as readonly string[]).includes(lokal)) return 'Stellium Team';
  return `Stellium ${lokal.charAt(0).toUpperCase()}${lokal.slice(1)} Team`;
}

/**
 * Anweisung für eine NEUE Mail ohne Ursprungsnachricht.
 *
 * Kein Gegenstück in post-ki.ts — GRUNDANWEISUNG dort geht durchgehend von
 * einer eingehenden, fremden Mail aus (die Marken, die Abwehr gegen
 * eingeschleuste Anweisungen). Hier gibt es keine fremde Mail: die
 * Themenangabe stammt von einer Kollegin oder einem Kollegen mit `mail.senden`
 * — also von genau der Person, die den Text gleich lesen und selbst auf
 * Senden drücken wird. Sie DARF als Auftrag gelten; die Marken-Abwehr aus
 * mailAlsEingabe() wäre hier fehl am Platz.
 *
 * Was bleibt, weil es unabhängig vom Absender gilt: nichts erfinden (wie
 * TEIL_ANWEISUNG in services/ai.ts: "Nichts hinzuerfinden. Steht etwas nicht
 * im Abschnitt, steht es auch nicht in deiner Liste." — hier sinngemäß auf
 * die Themenangabe übertragen), dieselbe Kennzeichnungspflicht, derselbe
 * Team-statt-Personenname.
 */
function anweisungFuerNeu(fach: string, sprache: string): string {
  const team = teamName(fach);
  const s = languageInfo(sprache);
  return [
    'Du bist ein Teammitglied von Stellium und schreibst im Auftrag einer Kollegin oder eines Kollegen eine neue Firmenmail an eine externe Adresse.',
    'Du versendest nie selbst. Die Kollegin oder der Kollege liest deinen Text und drückt selbst auf Senden — oder schreibt ihn vorher um.',
    'Die Angabe unten, worum es in der Mail gehen soll, kommt von dieser Kollegin oder diesem Kollegen, nicht von einer fremden Mail. Du darfst sie als Auftrag befolgen.',
    'Schreibe AUSSCHLIESSLICH auf Grundlage dieser Angabe. Erfinde keine Fakten, Zahlen, Preise, Zusagen, Fristen, Namen oder Einzelheiten, die dort nicht stehen — steht etwas nicht in der Angabe, steht es auch nicht in deinem Text. Ist die Angabe knapp, bleibt dein Text entsprechend knapp und allgemein, statt Lücken zu füllen.',
    `Ton: im Namen von Stellium, höflich, klar, ohne Markdown, mit Anrede. Unterschreibe mit "${team}" — nie mit einem Personennamen, auch nicht, wenn die Themenangabe danach fragt.`,
    `Schreibe auf ${s.name} (${s.native}).`,
    `Unter die Unterschrift gehört, in einer eigenen, durch eine Leerzeile abgesetzten Zeile, der Hinweis auf maschinelle Erstellung: Deutsch "${KENNZEICHNUNG_DE}", Englisch "${KENNZEICHNUNG_EN}", in jeder anderen Sprache derselbe Hinweis in der Sprache des Textes. Das ist Pflicht — nie weggelassen, gekürzt oder umformuliert.`,
    'Antworte NUR mit diesem JSON, ohne Text davor oder danach, ohne Codeblock:',
    '{"text": "<vollständiger Mailtext mit Anrede, Unterschrift und Kennzeichnung, ohne Betreffzeile>"}',
  ].join('\n');
}

/**
 * Einen Entwurf schreiben — Antwort auf eine vorhandene Mail, oder eine neue
 * Mail nach Themenangabe.
 */
export async function entwurfSchreiben(input: EntwurfSchreibenInput): Promise<EntwurfSchreibenErgebnis> {
  if (input.modus === 'antwort') {
    const mail = nachricht(input.mailId);
    if (!mail) throw abweisung('fehler.nichtGefunden', 'Diese Nachricht gibt es nicht.');

    /* Dieselbe Regel wie das Antwortfeld der Oberfläche selbst (siehe
       PostPanel.tsx::zielAdresse): bei einer eingegangenen Nachricht ihr
       Absender, bei einer bereits gesendeten ihr Empfänger. */
    const empfaenger = nurAdresse(mail.richtung === 'ein' ? mail.von : mail.an);
    const sprache = spracheFuer(empfaenger);

    const system = `${anweisungFuerFach(mail.fach)}\n`
      + `Die Antwort in \`entwurf\` schreibst du auf ${languageInfo(sprache).name} (${languageInfo(sprache).native}) — `
      + 'das ist die Sprache dieses Briefpartners, unabhängig davon, in welcher Sprache diese eine Nachricht verfasst ist.';
    const eingabe: EingehendeMailFuerKi = {
      von: mail.richtung === 'ein' ? mail.von : mail.an,
      betreff: mail.betreff,
      text: kuerzen(mail.text),
      anhaenge: mail.anhaenge.slice(0, 25).map((a) => ({ name: a.name })),
    };
    const user = mailAlsEingabe(eingabe);

    /* Dieselbe Antwortform wie in post-sichtung.ts (RohAntwort) — nur
       `entwurf` wird gelesen, der Rest (Einordnung, Dringlichkeit) ist für
       einen Knopfdruck-Vorschlag ohne Bedeutung. */
    const roh = await modellFragenRoh<{ entwurf?: unknown; antwortNoetig?: unknown }>(system, user);
    const entwurfstext = typeof roh.data.entwurf === 'string' ? roh.data.entwurf.trim() : '';
    if (!entwurfstext) {
      throw abweisung('post.kiOhneEntwurf',
        'Die KI hält hier keine Antwort für nötig oder hat keinen Text geliefert — bitte von Hand schreiben.');
    }

    const text = kennzeichnungSichern(entwurfstext.slice(0, ENTWURF_MAX), sprache);
    return { text, sprache, modell: roh.modell, kennzeichnung: kennzeichnungFuer(sprache) };
  }

  const thema = input.thema.trim().slice(0, THEMA_MAX);
  if (!thema) {
    throw abweisung('post.kiOhneThema',
      'Ohne Angabe, worum es gehen soll, kann die KI keinen sinnvollen Text schreiben.');
  }
  const empfaenger = nurAdresse(input.an);
  const sprache = spracheFuer(empfaenger);
  const system = anweisungFuerNeu(input.fach, sprache);
  const user = [`Empfänger: ${empfaenger}`, `Worum es gehen soll: ${thema}`].join('\n');

  const roh = await modellFragenRoh<{ text?: unknown }>(system, user);
  const rohtext = typeof roh.data.text === 'string' ? roh.data.text.trim() : '';
  if (!rohtext) {
    throw abweisung('post.kiOhneEntwurf', 'Die KI hat keinen Text geliefert — bitte von Hand schreiben.');
  }

  const text = kennzeichnungSichern(rohtext.slice(0, ENTWURF_MAX), sprache);
  return { text, sprache, modell: roh.modell, kennzeichnung: kennzeichnungFuer(sprache) };
}
