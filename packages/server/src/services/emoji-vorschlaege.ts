import { istE2EChiffrat, languageInfo } from '@stellium/shared';
import { db } from '../db/index.js';
import { entschluesseln, verschluesseln } from '../crypto/nachrichten.js';
import { getSetting, setSetting } from './settings.js';
import { assistant } from '../translation/index.js';
import { type AssistantProvider } from '../translation/providers/types.js';
import { mitKennung } from '../translation/fehler.js';
import { abweisung } from '../util/abweisung.js';

/**
 * KI-Rückfall für Emoji-Reaktionsvorschläge.
 *
 * DER NORMALFALL LIEGT WOANDERS
 *
 * Für die allermeisten Nachrichten braucht es diese Datei gar nicht: die App
 * schlägt drei Emoji örtlich vor, indem sie den (schon angezeigten, ohnehin
 * entschlüsselten) Nachrichtentext gegen den Namensbestand abgleicht —
 * packages/desktop/src/emoji/katalog.ts, emojiVorschlaege(). Kein Netz, kein
 * Modell, keine Kosten, nichts verlässt das Gerät.
 *
 * Hierher kommt nur, wer erstens örtlich nichts Passendes gefunden hat UND
 * zweitens ausdrücklich danach fragt (ein Klick in EmojiPicker.tsx — nie
 * automatisch, nie pro eingehender Nachricht). Der Aufruf steht in
 * ws/gateway.ts, Fall 'ai:reaction-suggest', mit denselben zwei Wächtern wie
 * jeder andere KI-Auftrag: das Recht 'ai.assistant' und
 * klartextNoetigFuerNachricht() — in einem vertraulichen Kanal hat der Server
 * ohnehin nur Chiffrat und käme gar nicht bis hierher.
 *
 * NIE DIESELBE NACHRICHT ZWEIMAL FRAGEN
 *
 * Das Ergebnis (auch ein leeres — "die KI hat nichts gefunden" ist eine
 * gültige, zu merkende Antwort) liegt danach in app_settings, verschlüsselt
 * wie jeder andere aus Nachrichtentext abgeleitete Wert in dieser Tabelle
 * (siehe services/vorschlaege.ts für dasselbe Muster). Ein zweiter Aufruf für
 * dieselbe Nachricht — von derselben Person noch einmal, oder von einer
 * anderen, die ebenfalls fragt — liest nur noch diesen Eintrag, ganz ohne das
 * Modell erneut zu bemühen. Das überlebt auch einen Neustart des Servers,
 * anders als ein reiner Arbeitsspeicher-Zwischenspeicher es täte.
 */

function ki(): AssistantProvider {
  const a = assistant();
  if (!a) {
    throw abweisung('fehler.kiNichtEingerichtet', 'Die KI ist für diesen Server nicht eingerichtet.');
  }
  return a;
}

function cacheSchluessel(messageId: string): string {
  return `emoji_vorschlag:${messageId}`;
}

function ausCache(messageId: string): string[] | null {
  const roh = getSetting(cacheSchluessel(messageId));
  if (!roh) return null;
  try {
    const liste = JSON.parse(entschluesseln(roh)) as unknown;
    return Array.isArray(liste) ? liste.filter((e): e is string => typeof e === 'string') : null;
  } catch {
    return null;
  }
}

function inCache(messageId: string, emojis: string[]): void {
  setSetting(cacheSchluessel(messageId), verschluesseln(JSON.stringify(emojis)), 'system');
}

/**
 * Bis zu drei Emoji für eine einzelne Nachricht — von der KI, einmalig.
 *
 * Gibt ein leeres Array zurück (nie einen Fehler), wenn die Nachricht nicht
 * mehr existiert, gelöscht ist, oder ihr Text sich als Chiffrat entpuppt —
 * dieselbe Rückhalt-Prüfung wie in services/ai.ts (zeile()) und
 * services/vorschlaege.ts (quelleLesbar()): die Kanalprüfung im Gateway ist
 * die erste Sperre, diese hier greift zusätzlich am Inhalt selbst.
 */
export async function reactionSuggest(messageId: string, language: string): Promise<string[]> {
  const gecached = ausCache(messageId);
  if (gecached) return gecached;

  const row = db.get<{ text: string }>(
    'SELECT text FROM messages WHERE id = ? AND deleted_at IS NULL', messageId,
  );
  if (!row) return [];
  if (istE2EChiffrat(row.text)) return [];
  const klartext = entschluesseln(row.text);
  if (istE2EChiffrat(klartext) || !klartext.trim()) return [];

  const lang = languageInfo(language);
  const ai = ki();

  const anweisung = [
    'Du schlägst passende Emoji-Reaktionen für eine einzelne Chat-Nachricht vor.',
    'Genau 3 Emoji, jedes ein einzelnes Unicode-Zeichen ohne Zusatztext.',
    `Die Nachricht ist auf ${lang.name} (${lang.native}) — wähle Emoji, die zum Inhalt und Ton passen.`,
    'JSON: {"emojis": ["...", "...", "..."]}',
  ].join('\n');

  const data = await mitKennung(() => ai.json<{ emojis?: string[] }>([
    { role: 'system', content: anweisung },
    { role: 'user', content: klartext.slice(0, 800) },
  ], { temperature: 0.4, maxTokens: 60, fast: true }));

  const ergebnis = (data.emojis ?? [])
    .filter((e) => typeof e === 'string' && e.trim().length > 0)
    .slice(0, 3);

  /* Auch ein leeres Ergebnis wird gemerkt — sonst würde der nächste Klick auf
     denselben Knopf noch einmal fragen, obwohl die Antwort "nichts Passendes"
     bereits feststeht. Ein echter Fehler (Modell nicht erreichbar) wirft
     dagegen schon in mitKennung() weiter oben und kommt hier nie an — der
     nächste Versuch bleibt also möglich. */
  inCache(messageId, ergebnis);
  return ergebnis;
}
