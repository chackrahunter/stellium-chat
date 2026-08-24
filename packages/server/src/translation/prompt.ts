import { languageInfo } from '@stellium/shared';
import type { TranslateRequest } from './providers/types.js';

/**
 * Die Anweisung, mit der jedes Sprachmodell hier übersetzt.
 *
 * Steht bewusst für sich und hängt an nichts außer den Sprachnamen: so lässt
 * sich derselbe Wortlaut messen, der im Betrieb hinausgeht
 * (scripts/echo-pruefen.mjs). Eine zweite, abgeschriebene Fassung im Prüflauf
 * wäre nach der ersten Änderung hier still falsch.
 */
export function uebersetzungsRegeln(req: TranslateRequest): string[] {
  const target = languageInfo(req.targetLang);
  const source = req.sourceLang ? languageInfo(req.sourceLang) : null;

  const regeln = [
    `Übersetze den Text ins ${target.name} (${target.native}).`,
    /* Steht bewusst schon im ersten Anlauf und nicht erst im Nachdruck-Block:
       gemessen (scripts/uebersetzung-messen.mjs) echot ein kleines Modell
       lange, unpunktierte Sätze beim ersten Versuch sonst zuverlässig statt
       sie zu übersetzen — der Nachdruck-Versuch rettet das nur in der Hälfte
       der Fälle. Vorbeugen schlägt Nachbessern. */
    'Übersetzen heißt: der gesamte Text steht danach in der Zielsprache — auch bei langen Sätzen ohne klare Satzzeichen. Nur Rechtschreibung auszubessern oder umzuformulieren zählt nicht als Übersetzung.',
    source ? `Ausgangssprache ist ${source.name}.` : 'Erkenne die Ausgangssprache selbst.',
    /* "nicht lockerer, nicht förmlicher" ergänzt die binäre Zuordnung
       locker/förmlich um die Richtung: gemessener Fehlerfall (22.08.2026) —
       normales Deutsch ("ich lade die App gerade runter") kam als schwerer
       Netzjargon zurück ("ima", "rn"). Kein Wort war falsch, trotzdem falsch.
       Bewusst nur angehängt statt als eigener Satz ("soll klingen wie
       dieselbe Person..."): eine längere Fassung hat in einem unabhängigen
       Fall (Rückübersetzung des lang-Korpus, "So in short, the following
       happened: ...") die Fehlerrate im Nachdruck-Versuch von 0/8 auf 3/5
       hochgezogen — gemessen mit scripts/uebersetzung-messen.mjs außerhalb
       des Korpus. Länge war hier der Risikofaktor, nicht die Idee. */
    'Es handelt sich um Nachrichten aus einem Firmen-Chat. Behalte den Tonfall bei: locker bleibt locker, förmlich bleibt förmlich — nicht lockerer, nicht förmlicher.',
    'Platzhalter der Form {{0}}, {{1}} usw. sind Code, Links, @Erwähnungen oder Produktnamen. Gib sie unverändert und vollzählig zurück.',
    'Übersetze keine Emojis und erfinde keine zusätzlichen Sätze.',
    'Behalte Zeilenumbrüche und Markdown-Struktur bei.',
  ];

  /* Zweiter Anlauf: der erste hat den Eingabetext zurückgegeben.
     Ein kleines Modell liest die Aufgabe bei Umgangssprache ohne Satzzeichen
     gern als „Text aufräumen" statt als „Text übersetzen" — deshalb steht hier
     ausdrücklich, was es nicht tun soll. */
  if (req.nachdruck) {
    regeln.push(
      `WICHTIG: Der vorige Versuch hat den Eingabetext unverändert zurückgegeben. Der Eingabetext ist NICHT ${target.name}.`,
      /* "und jedes Zeichen" ergänzt: gemessen (scripts/uebersetzung-messen.mjs,
         lang-Kategorie) mischte das Modell im Nachdruck-Versuch (temperature
         0.4) vereinzelt ein einzelnes fremdes Schriftzeichen mitten ins Wort
         ("zurückge滚" statt "zurückgerollt") — der Rest des Satzes stand
         korrekt in der Zielsprache. */
      `Gib ihn niemals unverändert zurück und mische keine andere Sprache ein. Jedes Wort und jedes Zeichen in "translation" muss ${target.name} (${target.native}) sein.`,
      'Korrigiere weder Rechtschreibung noch Zeichensetzung — übertrage den Sinn in die Zielsprache.',
      `Umgangssprache, Abkürzungen und Tippfehler werden sinngemäß ins ${target.name} übertragen, nicht stehen gelassen.`,
    );
  }

  if (req.glossary && Object.keys(req.glossary).length) {
    const paare = Object.entries(req.glossary).map(([k, v]) => `"${k}" -> "${v}"`).join(', ');
    regeln.push(`Verwende diese Firmen-Terminologie zwingend: ${paare}.`);
  }
  if (req.context) {
    regeln.push(`Kontext des Gesprächs (nur zur Orientierung, nicht übersetzen): ${req.context}`);
    /* Nur, wenn Kontext dasteht: gemessen (scripts/uebersetzung-messen.mjs,
       KONTEXT_KORPUS) hilft dieser Satz ohne vorherige Nachricht nicht —
       der Auftraggeber-Fall ("mache ich kein problem" -> "I'm not making a
       problem") blieb ohne Verlauf falsch, selbst mit diesem Satz. Erst mit
       einer vorherigen Nachricht als Kontext UND diesem Satz kippte die
       Übersetzung erkennbar in Richtung Zusage. Deshalb hier verankert statt
       als eigene, immer aktive Regel — die zusätzliche Zeile soll nur dort
       kosten (Marken, Risiko einer neuen Fehlübersetzung), wo tatsächlich
       Verlauf zur Verfügung steht. */
    regeln.push(
      'Nutze den Gesprächskontext, um zu erkennen, ob eine kurze Antwort eine Zusage, Absage oder Frage ist, '
      + 'und übersetze den vollen Sinn, nicht nur die Einzelwörter. Kurze Antworten ohne Satzzeichen sind im '
      + 'Chat oft mehrere knappe Aussagen ohne Komma (zum Beispiel Zusage und Beruhigung in einem Atemzug).',
    );
  }
  regeln.push('Antworte ausschließlich als JSON: {"translation": "...", "detected_source_language": "<ISO-639-1>", "confidence": <0..1>}');

  return regeln;
}

/**
 * Wie viele Tokens die Übersetzung höchstens brauchen darf.
 * Faustregel: rund ein Token pro drei Zeichen, dazu Luft für JSON-Gerüst und
 * die internen Denkschritte der Reasoning-Modelle.
 *
 * Der feste Deckel von 8192 ist hier bewusst raus: er hatte nichts mit dem
 * tatsächlichen Kontextfenster des jeweiligen Modells zu tun (das reicht von
 * 8k bei einem kleinen lokalen Modell bis 128k+ bei Groq) und zählte
 * außerdem nur die Antwort, nie die Anfrage selbst dazu — bei rund 4300
 * Zeichen reservierte die alte Formel schon mehr Antwort-Marken, als nach
 * Abzug der Anfrage überhaupt noch im Fenster übrig blieben, und jede
 * längere Nachricht scheiterte deshalb unabhängig vom Anbieter. Das
 * eigentliche Fenster kennt jetzt providers/openai-compatible.ts (kennt das
 * Modell) und begrenzt hiermit zusammen mit dem Platz, den die Anfrage
 * selbst schon braucht — siehe dort.
 */
export function translationBudget(text: string): number {
  const geschaetzt = Math.ceil(text.length / 3);
  return Math.max(1500, geschaetzt * 4 + 800);
}

/**
 * Beim ersten Anlauf soll dasselbe herauskommen wie beim letzten Mal. Beim
 * zweiten gerade nicht: bei 0 antwortet das Modell Wort für Wort dasselbe —
 * gemessen dreimal von drei Läufen.
 */
export function uebersetzungsTemperatur(req: TranslateRequest): number {
  return req.nachdruck ? 0.4 : 0;
}
