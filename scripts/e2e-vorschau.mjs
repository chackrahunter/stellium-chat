/** Die Vorschau muss zeigen, wie der Text beim Gegenüber ankommt. */
import { chromium } from 'playwright';
import { APP, LOGIN, PW, SERVER as S } from './zugang.mjs';


const ergebnisse = [];
const pruefe = async (n, f) => {
  try { const x = await f(); ergebnisse.push(1); console.log(`  ✓ ${n}${x ? ` — ${x}` : ''}`); }
  catch (e) { ergebnisse.push(0); console.log(`  ✗ ${n} — ${e.message.split('\n')[0]}`); }
};
const muss = (b, m) => { if (!b) throw new Error(m); };

const b = await chromium.launch({ headless: true });
const p = await (await b.newContext({ viewport: { width: 1400, height: 900 }, locale: 'de-DE' })).newPage();
await p.goto(APP);
await p.evaluate((s) => { localStorage.setItem('stellium.serverUrl', s); localStorage.setItem('stellium.tourGesehen', 'ja'); }, S);
await p.reload(); await p.waitForTimeout(1200);
if (await p.locator('.auth').count()) {
  await p.locator('.auth input').first().fill(LOGIN);
  await p.locator('.auth input[type="password"]').first().fill(PW);
  await p.locator('.auth button[type="submit"]').first().click();
}
await p.waitForSelector('.app', { timeout: 20000 });
await p.waitForTimeout(2000);

/** Eine Direktnachricht mit jemandem, der eine andere Sprache liest. */
const anderssprachig = await p.evaluate(() => {
  const s = window.__stelliumStore?.getState?.();
  return s ? Object.values(s.users).filter((u) => u.role !== 'bot' && !u.disabled).map((u) => ({ id: u.id, sprache: u.language })) : null;
});

await pruefe('Vorschau erscheint in der Direktnachricht', async () => {
  // Einen Direktchat öffnen: die Liste unter "Direktnachrichten".
  const dms = p.locator('.group', { hasText: /Direktnachricht/i }).first().locator('.chan');
  const anzahl = await dms.count();
  muss(anzahl > 0, 'kein Direktchat vorhanden');

  let gefunden = null;
  for (let i = 0; i < anzahl; i++) {
    await dms.nth(i).click();
    await p.waitForTimeout(900);
    const info = await p.evaluate(() => {
      const s = window.__stelliumStore?.getState?.();
      if (!s) return null;
      const ch = s.channels[s.activeChannelId];
      const gegen = s.users[ch?.dmPeerId ?? ''];
      return { art: ch?.kind, meine: s.self?.language, seine: gegen?.language, bot: gegen?.role === 'bot' };
    });
    if (info && info.art === 'dm' && !info.bot && info.seine && info.seine !== info.meine) { gefunden = info; break; }
  }
  /* Ein Übersprung zählte hier als bestanden — und zwar genau in dem Fall,
     für den es diese Datei gibt. Der Zustand, den sie braucht (ein Direktchat
     mit jemandem anderer Sprache), entsteht durch keinen Lauf hier von selbst;
     fehlt er, ist nichts gemessen und das muss man sehen. */
  muss(gefunden, 'kein anderssprachiger Direktchat vorhanden — die Vorschau wurde nicht geprüft');

  await p.locator('.composer__input').fill('Wir treffen uns morgen um zehn Uhr im Büro.');
  await p.waitForSelector('.composer__preview', { timeout: 30000 });
  const text = await p.locator('.composer__preview').innerText();
  muss(text.length > 20, `Vorschau leer: ${text}`);
  muss(!/Wir treffen uns morgen um zehn/.test(text.split('\n').slice(1).join(' ')), 'zeigt denselben deutschen Satz');
  return `${gefunden.meine} → ${gefunden.seine}: "${text.split('\n').slice(1).join(' ').slice(0, 50)}"`;
});

await pruefe('Kurze Texte bekommen auch eine Vorschau', async () => {
  const sichtbar = await p.locator('.composer__preview').count();
  muss(sichtbar, 'kein anderssprachiger Chat — die Vorschau wurde nicht geprüft');
  await p.locator('.composer__input').fill('Danke!');
  await p.waitForTimeout(4000);
  muss(await p.locator('.composer__preview').count() > 0, 'keine Vorschau bei kurzem Text');
});

await p.locator('.composer__input').fill('');
await b.close();
const schlecht = ergebnisse.filter((x) => !x).length;
console.log(`\n${ergebnisse.length - schlecht}/${ergebnisse.length} bestanden`);
process.exit(schlecht ? 1 : 0);
