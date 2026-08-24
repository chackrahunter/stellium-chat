/**
 * Entdeckungslauf VOR jeder Musterbildung: sammelt rohe (ohne, mit)-Paare
 * für POLARITAET_KORPUS_DE, damit die deutschen Absage-/Zusage-Muster in
 * polaritaet.ts auf tatsächlich beobachtete Ausgaben gebaut werden können —
 * nicht geraten. Kein Klassifizierer hier, nur Sammlung + Ausgabe zum
 * Vonhandlesen (dieselbe Disziplin wie beim ersten Englisch-Fund).
 *
 *   MODELL=http://127.0.0.1:11500/v1 MODELL_ID=qwen3-8b node scripts/polaritaet-de-entdecken.mjs
 */
import { normalizeLang } from '../packages/shared/src/languages.ts';
import { maskText, unmaskText } from '../packages/shared/src/markup.ts';
import { istEcho } from '../packages/server/src/translation/echo.ts';
import { translationBudget, uebersetzungsRegeln, uebersetzungsTemperatur }
  from '../packages/server/src/translation/prompt.ts';
import { uebersetzungAusAntwort } from '../packages/server/src/translation/antwort.ts';
import { verlaufAlsKontext } from '../packages/server/src/translation/verlauf.ts';
import { POLARITAET_KORPUS_DE } from './uebersetzung-korpus.mjs';

const ADRESSE = process.env.MODELL;
if (!ADRESSE) { console.error('MODELL=<baseUrl> setzen'); process.exit(1); }
const MODELL_ID = process.env.MODELL_ID ?? 'qwen3-8b';
const REPS = Number(process.env.REPS) || 3;

async function einzelneAnfrage(text, ziel, quelle, nachdruck, context = null) {
  const req = { text, targetLang: ziel, sourceLang: quelle, nachdruck, context };
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
  });
  if (!res.ok) return null;
  const inhalt = (await res.json())?.choices?.[0]?.message?.content;
  if (typeof inhalt !== 'string') return null;
  return uebersetzungAusAntwort(inhalt.trim(), text);
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

console.log(`\nEntdeckungslauf EN→DE an ${MODELL_ID} — ${POLARITAET_KORPUS_DE.length} Fälle × ${REPS} Wiederholungen\n`);
let nr = 0;
for (const fall of POLARITAET_KORPUS_DE) {
  nr++;
  const { masked, tokens } = maskText(fall.text, { protectedTerms: [] });
  const kontext = verlaufAlsKontext(fall.vorher);
  console.log(`[${String(nr).padStart(2)}/${POLARITAET_KORPUS_DE.length}] ${fall.gruppe.padEnd(24)} "${fall.text}" (erwartet: ${fall.erwartetePolaritaet})`);
  for (const lauf of ['ohne', 'mit']) {
    const texte = [];
    for (let i = 0; i < REPS; i++) {
      const ergebnis = await uebersetzeMitNachfassen(masked, fall.ziel, fall.quelle, lauf === 'mit' ? kontext : null);
      texte.push(ergebnis ? unmaskText(ergebnis.translation, tokens) : '(keine Antwort)');
    }
    console.log(`  ${lauf.padEnd(6)} ${texte.join('  |  ')}`);
  }
}
