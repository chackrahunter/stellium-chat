/**
 * Misst den NUTZEN von Kontext für Deutsch als Zielsprache (EN→DE) — das
 * Gegenstück zur ursprünglichen Kontext-Messung (Runde 1, Deutsch→Englisch,
 * KONTEXT_KORPUS in uebersetzung-messen.mjs), nicht das Schadensrisiko
 * (das misst scripts/polaritaet-de-messen.mjs). Rückfrage der Koordination:
 * "du hast gemessen, dass Kontext dort nicht schadet — nicht, dass er
 * etwas bringt." Dieselbe Sorgfalt wie Runde 1: derselbe Korpusaufbau
 * (KONTEXT_KORPUS_DE, siehe uebersetzung-korpus.mjs), erwartet/verboten je
 * Fall, mehrere Wiederholungen bei temperature 0.
 *
 *   ssh -f -N -L 11500:100.125.43.46:11500 stellium
 *   MODELL=http://127.0.0.1:11500/v1 MODELL_ID=qwen3-8b node scripts/kontext-de-messen.mjs
 */
import { normalizeLang } from '../packages/shared/src/languages.ts';
import { maskText, unmaskText } from '../packages/shared/src/markup.ts';
import { istEcho } from '../packages/server/src/translation/echo.ts';
import { translationBudget, uebersetzungsRegeln, uebersetzungsTemperatur }
  from '../packages/server/src/translation/prompt.ts';
import { uebersetzungAusAntwort } from '../packages/server/src/translation/antwort.ts';
import { verlaufAlsKontext } from '../packages/server/src/translation/verlauf.ts';
import { KONTEXT_KORPUS_DE } from './uebersetzung-korpus.mjs';

const ADRESSE = process.env.MODELL;
if (!ADRESSE) {
  console.error('MODELL=<baseUrl> setzen, z. B.:');
  console.error('  MODELL=http://127.0.0.1:11500/v1 MODELL_ID=qwen3-8b node scripts/kontext-de-messen.mjs');
  process.exit(1);
}
const MODELL_ID = process.env.MODELL_ID ?? 'qwen3-8b';
const REPS = Number(process.env.REPS) || 3;

const ERGEBNIS = { BESTANDEN: 'bestanden', DURCHGEFALLEN: 'durchgefallen', UEBERSPRUNGEN: 'übersprungen' };

async function einzelneAnfrage(text, ziel, quelle, nachdruck, context = null) {
  const req = { text, targetLang: ziel, sourceLang: quelle, nachdruck, context };
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 45_000);
  try {
    const res = await fetch(`${ADRESSE.replace(/\/+$/, '')}/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: 'Bearer pruefung' },
      body: JSON.stringify({
        model: MODELL_ID,
        messages: [{ role: 'system', content: uebersetzungsRegeln(req).join('\n') }, { role: 'user', content: text }],
        temperature: uebersetzungsTemperatur(req),
        max_completion_tokens: translationBudget(text),
        response_format: { type: 'json_object' },
      }),
      signal: controller.signal,
    });
    if (!res.ok) return null;
    const inhalt = (await res.json())?.choices?.[0]?.message?.content;
    if (typeof inhalt !== 'string') return null;
    return uebersetzungAusAntwort(inhalt.trim(), text);
  } catch {
    return null;
  } finally {
    clearTimeout(timeout);
  }
}
async function uebersetzeMitNachfassen(masked, ziel, quelle, context = null) {
  const erste = await einzelneAnfrage(masked, ziel, quelle, false, context);
  if (!erste || !erste.translation?.trim()) return null;
  const erkannteQuelle = erste.detected ? normalizeLang(erste.detected) : quelle;
  if (erkannteQuelle === ziel) return erste;
  if (!istEcho(masked, erste.translation)) return erste;
  const zweite = await einzelneAnfrage(masked, ziel, quelle, true, context);
  if (zweite?.translation?.trim() && !istEcho(masked, zweite.translation)) return zweite;
  return zweite?.translation?.trim() ? zweite : erste;
}

function pruefeErwartet(text, muster) {
  if (!muster.length) return ERGEBNIS.UEBERSPRUNGEN;
  return muster.every((r) => r.test(text)) ? ERGEBNIS.BESTANDEN : ERGEBNIS.DURCHGEFALLEN;
}
function pruefeVerboten(text, muster) {
  if (!muster.length) return ERGEBNIS.UEBERSPRUNGEN;
  return muster.some((r) => r.test(text)) ? ERGEBNIS.DURCHGEFALLEN : ERGEBNIS.BESTANDEN;
}

console.log(`\nKontext-Nutzen-Messung EN→DE an ${MODELL_ID} über ${ADRESSE}`);
console.log(`${KONTEXT_KORPUS_DE.length} Fälle × 2 Bedingungen (ohne/mit Kontext) × ${REPS} Wiederholungen\n`);

const LAEUFE = ['ohne', 'mit'];
const zaehler = { ohne: { bestanden: 0, durchgefallen: 0, uebersprungen: 0 }, mit: { bestanden: 0, durchgefallen: 0, uebersprungen: 0 } };
const beispiele = [];

for (const fall of KONTEXT_KORPUS_DE) {
  const { masked, tokens } = maskText(fall.text, { protectedTerms: [] });
  const kontext = verlaufAlsKontext(fall.vorher);
  console.log(`  ${fall.name}`);
  if (fall.vorher?.length) for (const v of fall.vorher) console.log(`    vorher  ${v.wer}: ${v.text}`);
  console.log(`    Text    ${fall.text}`);

  const texteJeLauf = {};
  for (const lauf of LAEUFE) {
    const texte = [];
    for (let i = 0; i < REPS; i++) {
      const ergebnis = await uebersetzeMitNachfassen(masked, fall.ziel, fall.quelle, lauf === 'mit' ? kontext : null);
      const text = ergebnis ? unmaskText(ergebnis.translation, tokens) : '';
      texte.push(text);
      const erwartetR = pruefeErwartet(text, fall.erwartet);
      const verbotenR = pruefeVerboten(text, fall.verboten);
      const r = (erwartetR === ERGEBNIS.DURCHGEFALLEN || verbotenR === ERGEBNIS.DURCHGEFALLEN)
        ? ERGEBNIS.DURCHGEFALLEN
        : (erwartetR === ERGEBNIS.UEBERSPRUNGEN && verbotenR === ERGEBNIS.UEBERSPRUNGEN)
          ? ERGEBNIS.UEBERSPRUNGEN : ERGEBNIS.BESTANDEN;
      if (r === ERGEBNIS.BESTANDEN) zaehler[lauf].bestanden++;
      else if (r === ERGEBNIS.DURCHGEFALLEN) zaehler[lauf].durchgefallen++;
      else zaehler[lauf].uebersprungen++;
    }
    texteJeLauf[lauf] = texte;
    console.log(`    ${lauf.padEnd(6)} ${texte.join('  |  ')}`);
  }
  beispiele.push({ name: fall.name, vorher: fall.vorher, text: fall.text, ohne: texteJeLauf.ohne[0], mit: texteJeLauf.mit[0] });
  console.log('');
}

console.log('── Ergebnis ohne vs. mit Kontext ──\n');
for (const lauf of LAEUFE) {
  const z = zaehler[lauf];
  const geprueft = z.bestanden + z.durchgefallen;
  const quote = geprueft ? Math.round((z.bestanden / geprueft) * 100) : 0;
  console.log(`  ${lauf.padEnd(6)} ${z.bestanden} von ${geprueft} (${quote} %)${z.uebersprungen ? `  [${z.uebersprungen} übersprungen — nur Beobachtung]` : ''}`);
}

console.log('\n── Alle Beispiele im Wortlaut (erste Wiederholung je Fall) ──\n');
for (const b of beispiele) {
  console.log(`  ${b.name}`);
  if (b.vorher?.length) for (const v of b.vorher) console.log(`    vorher: ${v.wer}: ${v.text}`);
  console.log(`    Text:   ${b.text}`);
  console.log(`    ohne:   ${b.ohne}`);
  console.log(`    mit:    ${b.mit}`);
  console.log('');
}

console.log('Standaufnahme, kein Grenzwert-Test — Ziel ist der Vergleich ohne/mit Kontext.');
process.exit(0);
