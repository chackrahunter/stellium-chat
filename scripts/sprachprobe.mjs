/* Reproduziert: bleibt in englischer Oberfläche irgendwo Deutsch stehen? */
import { chromium } from 'playwright';
import { probeserver } from './probeserver.mjs';

const APP = 'http://localhost:5173';
const probe = await probeserver();
const b = await chromium.launch({ headless: true });
const p = await (await b.newContext({ viewport: { width: 1400, height: 900 }, locale: 'en-US' })).newPage();

await p.goto(APP);
await p.evaluate(([s, t]) => {
  localStorage.setItem('stellium.serverUrl', s);
  localStorage.setItem('stellium.token', t);
  localStorage.setItem('stellium.tourGesehen', 'ja');
}, [probe.S, probe.token]);
await p.reload();
await p.waitForSelector('.app', { timeout: 20000 });

/* Dons Fall nachstellen: erst auf Deutsch lesen, dann umschalten. Wer die
   Sprache erst nach dem Zeichnen wechselt, deckt Stellen auf, die sich das
   Ergebnis gemerkt haben und nicht neu zeichnen. */
await p.evaluate(() => window.__stelliumStore.getState().updatePrefs({ uiLanguage: 'de' }));
await p.waitForTimeout(1200);

// Eine Nachricht schreiben, damit es etwas zu übersetzen gibt
await p.evaluate(() => {
  const s = window.__stelliumStore.getState();
  s.sendMessage({ channelId: s.activeChannelId, text: 'Hallo, das ist ein deutscher Satz zum Testen.' });
});
await p.waitForTimeout(2500);

/* Die Zeile „Übersetzt aus …" erscheint nur an einer Nachricht, die wirklich
   eine Übersetzung trägt. Ohne KI entsteht keine — also von Hand eine
   anhängen, sonst prüft der Lauf genau die Stelle nicht, um die es geht. */
await p.evaluate(() => {
  const store = window.__stelliumStore;
  const kanal = store.getState().activeChannelId;
  store.setState((alt) => {
    const liste = alt.messages[kanal] ?? [];
    if (!liste.length) return {};
    const letzte = { ...liste[liste.length - 1], sourceLang: 'de',
      translation: { lang: 'en', text: 'Hello, this is a German sentence for testing.', provider: 'local' } };
    return { messages: { ...alt.messages, [kanal]: [...liste.slice(0, -1), letzte] } };
  });
});
await p.waitForTimeout(1200);

// Jetzt erst umschalten — mit allem, was schon auf dem Schirm steht.
await p.evaluate(() => window.__stelliumStore.getState().updatePrefs({ uiLanguage: 'en' }));
await p.waitForTimeout(2000);

const deutsch = /\b(Übersetzt|Kanäle|Nachricht|Einstellungen|Suche|Mitglieder|Schließen|Speichern|Abbrechen|heute|gestern|Aufgaben|Dateien|Ideen)\b/;
const treffer = await p.evaluate((muster) => {
  const re = new RegExp(muster, 'u');
  const gefunden = [];
  const lauf = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
  let k;
  while ((k = lauf.nextNode())) {
    const text = (k.textContent || '').trim();
    if (!text || text.length > 120) continue;
    if (!re.test(text)) continue;
    const el = k.parentElement;
    gefunden.push({ text, klasse: el?.className?.toString().slice(0, 40) || '', tag: el?.tagName });
  }
  return gefunden.slice(0, 20);
}, deutsch.source);

/* Erst nachsehen, ob die fragliche Zeile überhaupt gezeichnet wurde. Ein Test,
   der ein fehlendes Element für "in Ordnung" hält, prüft gar nichts. */
const meta = await p.evaluate(() => {
  const el = document.querySelector('.translated__meta');
  return el ? el.textContent.trim() : null;
});
console.log(`Übersetzungszeile im Dokument: ${meta === null ? 'FEHLT — nichts geprüft' : `„${meta}"`}`);
console.log(`Oberfläche auf Englisch — deutsche Reste: ${treffer.length}`);
for (const t of treffer) console.log(`  „${t.text}"  ← ${t.tag}.${t.klasse}`);

await b.close();
await probe.stop();

/* Der Kommentar über `meta` sagte schon das Richtige — „ein Test, der ein
   fehlendes Element für in Ordnung hält, prüft gar nichts" —, und dann stand
   darunter nur ein `console.log`. Die Datei endete ohne Rückgabewert: beliebig
   viele deutsche Reste und eine fehlende Übersetzungszeile ergaben eine Null.
   Jetzt gilt beides als Fehlschlag. */
const maengel = [];
if (meta === null) maengel.push('die Übersetzungszeile wurde gar nicht gezeichnet');
if (treffer.length) maengel.push(`${treffer.length} deutsche Reste in der englischen Oberfläche`);
if (maengel.length) {
  console.log(`\n✗ ${maengel.join(' · ')}`);
  process.exit(1);
}
console.log('\n✓ Englische Oberfläche ohne deutsche Reste, Übersetzungszeile steht.');
process.exit(0);
