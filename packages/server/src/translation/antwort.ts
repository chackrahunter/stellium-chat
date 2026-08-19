/**
 * Die Übersetzung aus der Antwort holen — auch wenn kein JSON kam.
 *
 * Verlangt wird ein Objekt. Groq liefert das; llama.cpp erzwingt mit
 * response_format nur gültiges JSON und manchmal gar nichts, sodass die
 * Übersetzung als nackte JSON-Zeichenkette oder als blanker Text ankommt.
 * Beides wegzuwerfen hieße, dem Leser gar nichts zu zeigen, obwohl die
 * Übersetzung dasteht — gemessen betraf das an qwen3-8b jede zehnte Anfrage
 * ins Türkische.
 *
 * Blanker Text wird nur angenommen, wenn nichts auf ein zerbrochenes JSON,
 * ein Vorwort oder eine Erklärung statt einer Übersetzung hindeutet.
 */
export function uebersetzungAusAntwort(roh: string, eingabe: string): {
  translation: string; detected: string | null; confidence: number | null;
} | null {
  const text = roh.trim();
  if (!text) return null;

  // Erst das Ganze, dann ein eingebettetes Objekt (manche Modelle stellen Text voran).
  for (const kandidat of [text, text.match(/\{[\s\S]*\}/)?.[0]]) {
    if (!kandidat) continue;
    let daten: unknown;
    try { daten = JSON.parse(kandidat); } catch { continue; }

    if (typeof daten === 'string' && daten.trim()) {
      return { translation: daten, detected: null, confidence: null };
    }
    if (daten && typeof daten === 'object') {
      const o = daten as { translation?: unknown; detected_source_language?: unknown; confidence?: unknown };
      if (typeof o.translation === 'string') {
        return {
          translation: o.translation,
          detected: typeof o.detected_source_language === 'string' ? o.detected_source_language : null,
          confidence: typeof o.confidence === 'number' ? Math.max(0, Math.min(1, o.confidence)) : null,
        };
      }
    }
  }

  // Eine Klammer heißt: es war JSON gemeint und ist zerbrochen. Nicht raten.
  if (/[{}]/.test(text)) return null;
  // Ein Vorwort ist keine Übersetzung.
  if (/^(here (is|are)\b|hier ist\b|sure[,!]|translation\s*:|übersetzung\s*:)/i.test(text)) return null;
  // Deutlich länger als die Eingabe heißt: das Modell erklärt, statt zu übersetzen.
  if (text.length > eingabe.length * 4 + 200) return null;

  return { translation: text, detected: null, confidence: null };
}
