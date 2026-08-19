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
    source ? `Ausgangssprache ist ${source.name}.` : 'Erkenne die Ausgangssprache selbst.',
    'Es handelt sich um Nachrichten aus einem Firmen-Chat. Behalte den Tonfall bei: locker bleibt locker, förmlich bleibt förmlich.',
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
      `Gib ihn niemals unverändert zurück. Jedes Wort in "translation" muss ${target.name} (${target.native}) sein.`,
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
  }
  regeln.push('Antworte ausschließlich als JSON: {"translation": "...", "detected_source_language": "<ISO-639-1>", "confidence": <0..1>}');

  return regeln;
}

/**
 * Wie viele Tokens die Übersetzung höchstens brauchen darf.
 * Faustregel: rund ein Token pro drei Zeichen, dazu Luft für JSON-Gerüst und
 * die internen Denkschritte der Reasoning-Modelle.
 */
export function translationBudget(text: string): number {
  const geschaetzt = Math.ceil(text.length / 3);
  return Math.min(8192, Math.max(1500, geschaetzt * 4 + 800));
}

/**
 * Beim ersten Anlauf soll dasselbe herauskommen wie beim letzten Mal. Beim
 * zweiten gerade nicht: bei 0 antwortet das Modell Wort für Wort dasselbe —
 * gemessen dreimal von drei Läufen.
 */
export function uebersetzungsTemperatur(req: TranslateRequest): number {
  return req.nachdruck ? 0.4 : 0;
}
