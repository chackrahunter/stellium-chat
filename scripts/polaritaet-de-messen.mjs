/**
 * Deutsches Gegenstück zu scripts/polaritaet-messen.mjs — dieselbe
 * Disziplin, für Deutsch als Zielsprache (EN→DE), wie von der Koordination
 * verlangt: "Baue die deutschen Muster genauso wie die englischen, halte
 * eine zweite, unabhängige Stichprobe zurück, berichte Trefferquote und
 * Fehlalarme mit derselben Sorgfalt."
 *
 * WICHTIGER UNTERSCHIED ZU ENGLISCH: für EN→DE fand der Entdeckungslauf
 * (scripts/polaritaet-de-entdecken.mjs, 36 Fälle + 8 zusätzliche, bewusst
 * extrem elliptische Stichproben ohne jede Verneinung) KEINE einzige echte
 * Invertierung. Die "Trefferquote" unten ist deshalb nicht an einer
 * bekannten Invertierung gemessen (es gibt keine bekannte) — nur die
 * Fehlalarmquote lässt sich an echten Modellausgaben prüfen. Die
 * Trefferquote wird stattdessen an einer von Hand erdachten, unabhängigen
 * Stichprobe erfasst (RUNDE 2 unten) — dieselbe Methode wie die englische
 * gehaltene Stichprobe im ersten Bericht, hier aber die EINZIGE Quelle für
 * eine Trefferquote, nicht eine zusätzliche Bestätigung.
 *
 *   ssh -f -N -L 11500:100.125.43.46:11500 stellium
 *   MODELL=http://127.0.0.1:11500/v1 MODELL_ID=qwen3-8b node scripts/polaritaet-de-messen.mjs
 */
import { normalizeLang } from '../packages/shared/src/languages.ts';
import { maskText, unmaskText } from '../packages/shared/src/markup.ts';
import { istEcho } from '../packages/server/src/translation/echo.ts';
import { translationBudget, uebersetzungsRegeln, uebersetzungsTemperatur }
  from '../packages/server/src/translation/prompt.ts';
import { uebersetzungAusAntwort } from '../packages/server/src/translation/antwort.ts';
import { verlaufAlsKontext } from '../packages/server/src/translation/verlauf.ts';
import { klassifizierePolaritaet, polaritaetsWiderspruch } from '../packages/server/src/translation/polaritaet.ts';
import { POLARITAET_KORPUS_DE, POLARITAET_MEHRDEUTIG_KORPUS_DE } from './uebersetzung-korpus.mjs';

const ADRESSE = process.env.MODELL;
if (!ADRESSE) {
  console.error('MODELL=<baseUrl> setzen, z. B.:');
  console.error('  MODELL=http://127.0.0.1:11500/v1 MODELL_ID=qwen3-8b node scripts/polaritaet-de-messen.mjs');
  process.exit(1);
}
const MODELL_ID = process.env.MODELL_ID ?? 'qwen3-8b';
const REPS = Number(process.env.REPS) || 3;

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

/* ── RUNDE 1: echter Korpus (POLARITAET_KORPUS_DE) — Fehlalarmquote ──── */

console.log(`\nPolaritäts-Messung (Deutsch als Ziel) an ${MODELL_ID} über ${ADRESSE}`);
console.log(`${POLARITAET_KORPUS_DE.length} Fälle × 2 Bedingungen × ${REPS} Wiederholungen\n`);

const waechter = { unnoetigAusgeloest: 0, richtigRuhig: 0 };
for (const fall of POLARITAET_KORPUS_DE) {
  const { masked, tokens } = maskText(fall.text, { protectedTerms: [] });
  const kontext = verlaufAlsKontext(fall.vorher);
  const texteJeLauf = { ohne: [], mit: [] };
  for (const lauf of ['ohne', 'mit']) {
    for (let i = 0; i < REPS; i++) {
      const ergebnis = await uebersetzeMitNachfassen(masked, fall.ziel, fall.quelle, lauf === 'mit' ? kontext : null);
      texteJeLauf[lauf].push(ergebnis ? unmaskText(ergebnis.translation, tokens) : null);
    }
  }
  console.log(`  ${fall.gruppe.padEnd(24)} "${fall.text}" (erwartet: ${fall.erwartetePolaritaet})`);
  console.log(`    ohne  ${texteJeLauf.ohne.join(' | ')}`);
  console.log(`    mit   ${texteJeLauf.mit.join(' | ')}`);
  for (let i = 0; i < REPS; i++) {
    if (!texteJeLauf.ohne[i] || !texteJeLauf.mit[i]) continue;
    const ausgeloest = polaritaetsWiderspruch(texteJeLauf.ohne[i], texteJeLauf.mit[i], 'de');
    if (ausgeloest) {
      waechter.unnoetigAusgeloest++;
      console.log(`    [WÄCHTER LÖST AUS — laut Entdeckungslauf gibt es hier KEINE bekannte Invertierung] ${fall.name}`);
    } else {
      waechter.richtigRuhig++;
    }
  }
}

console.log('\n══ Mehrdeutig-Kontrolle (Deutsch) ══\n');
for (const fall of POLARITAET_MEHRDEUTIG_KORPUS_DE) {
  const { masked, tokens } = maskText(fall.text, { protectedTerms: [] });
  const kontext = verlaufAlsKontext(fall.vorher);
  const texteJeLauf = { ohne: [], mit: [] };
  for (const lauf of ['ohne', 'mit']) {
    for (let i = 0; i < REPS; i++) {
      const ergebnis = await uebersetzeMitNachfassen(masked, fall.ziel, fall.quelle, lauf === 'mit' ? kontext : null);
      texteJeLauf[lauf].push(ergebnis ? unmaskText(ergebnis.translation, tokens) : null);
    }
  }
  console.log(`  ${fall.name}`);
  console.log(`    ohne  ${texteJeLauf.ohne.join(' | ')}`);
  console.log(`    mit   ${texteJeLauf.mit.join(' | ')}`);
  for (let i = 0; i < REPS; i++) {
    if (!texteJeLauf.ohne[i] || !texteJeLauf.mit[i]) continue;
    const ausgeloest = polaritaetsWiderspruch(texteJeLauf.ohne[i], texteJeLauf.mit[i], 'de');
    if (ausgeloest) {
      waechter.unnoetigAusgeloest++;
      console.log(`    [WÄCHTER LÖST AUS — POSITIVKONTROLLE, DARF NICHT SEIN] ${fall.name}`);
    } else {
      waechter.richtigRuhig++;
    }
  }
}

console.log('\n── Runde 1, Ergebnis ──');
console.log(`  Fehlalarme: ${waechter.unnoetigAusgeloest} von ${waechter.unnoetigAusgeloest + waechter.richtigRuhig}`
  + ` (${waechter.unnoetigAusgeloest + waechter.richtigRuhig ? Math.round((waechter.unnoetigAusgeloest / (waechter.unnoetigAusgeloest + waechter.richtigRuhig)) * 100) : 0} %)`);

/* ── RUNDE 2: unabhängige, von Hand erdachte Stichprobe — Trefferquote ── */
/* NICHT beim Bauen der Muster in polaritaet.ts verwendet. Erfundene, aber
   plausible (ohne, mit)-Paare auf Deutsch, in beide Richtungen, mit
   bekannter erwarteter Antwort — dieselbe Methode wie die englische
   gehaltene Stichprobe im ersten Bericht. */
const GEHALTEN = [
  ['Lass uns lieber warten', 'Ja, machen wir das sofort', true],
  ['Ich bin raus', 'Klar, bin dabei', true],
  ['Eher nicht heute', 'Auf jeden Fall, lass uns loslegen', true],
  ['Kein Bock gerade', 'Na klar, sofort', true],
  ['Muss nicht sein', 'Für sure, machen wir', true],
  ['Ich glaub nicht', 'Klingt gut, machen wir', true],
  ['Können wir machen, aber erst morgen', 'Machen wir jetzt gleich', false],
  ['Vielleicht, mal schauen', 'Vielleicht, mal schauen', false],
  ['Vertagen wir das lieber', 'Verschieben wir das um eine Woche', false],
  ['Vielleicht nicht die beste Idee gerade', 'Perfektes Timing', false],
  ['Vielleicht, aber unter Vorbehalt', 'Kommt drauf an', false],
  ['Wär grundsätzlich dabei, aber nicht heute', 'Bin komplett dabei', false],
];
console.log('\n══ Runde 2: unabhängige gehaltene Stichprobe (nicht zum Bauen der Muster verwendet) ══\n');
let gehaltenRichtig = 0;
for (const [ohne, mit, erwartet] of GEHALTEN) {
  const ergebnis = polaritaetsWiderspruch(ohne, mit, 'de');
  const ok = ergebnis === erwartet;
  if (ok) gehaltenRichtig++;
  console.log(`  ${ok ? 'OK  ' : 'FEHL'} ${String(ergebnis).padEnd(5)} erwartet ${String(erwartet).padEnd(5)} <- ${JSON.stringify(ohne)} / ${JSON.stringify(mit)}`);
}
console.log(`\n  ${gehaltenRichtig} von ${GEHALTEN.length} richtig (${Math.round((gehaltenRichtig / GEHALTEN.length) * 100)} %).`);

console.log('\nStandaufnahme, kein Grenzwert-Test.');
process.exit(0);
