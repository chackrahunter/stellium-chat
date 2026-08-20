/**
 * Der Eingang für KI-Vorschläge auf zehn Gerätegrößen.
 *
 * scripts/schirmbilder.mjs zeigt die Oberfläche, wie sie beim Start dasteht —
 * Fenster, die man erst öffnen muss, kommen dort nicht vor. Für diesen Eingang
 * ist aber genau das die Frage: passt eine Karte mit Titel, Herkunft und drei
 * Knöpfen auf ein iPhone SE, und lässt sich der Änderungsbereich dort noch
 * bedienen?
 *
 * Der Inhalt wird direkt in den Laden gelegt und nicht über den Server geholt.
 * Ein Bild von einem leeren Kasten beweist nichts, und die Karten sollen auch
 * dann entstehen, wenn gerade kein Sprachmodell erreichbar ist. Dass der Weg
 * vom Server bis in den Laden stimmt, prüft e2e-vorschlaege.mjs.
 */
import fs from 'node:fs';
import { chromium, webkit, devices } from 'playwright';
import { DatabaseSync } from 'node:sqlite';
import { probeserver } from './probeserver.mjs';

const APP = process.env.STELLIUM_APP ?? 'http://localhost:5173';
const ZIEL = process.env.STELLIUM_BILDER ?? 'schirmbilder/vorschlaege';

const GERAETE = [
  { name: '01-iphone-se',      maschine: 'webkit',   breite: 375,  hoehe: 667,  geraet: 'iPhone SE' },
  { name: '02-iphone-pro',     maschine: 'webkit',   breite: 402,  hoehe: 874,  geraet: 'iPhone 15 Pro' },
  { name: '03-iphone-pro-max', maschine: 'webkit',   breite: 440,  hoehe: 956,  geraet: 'iPhone 15 Pro Max' },
  { name: '04-android-klein',  maschine: 'chromium', breite: 360,  hoehe: 800,  geraet: 'Galaxy S9+' },
  { name: '05-android-gross',  maschine: 'chromium', breite: 412,  hoehe: 915,  geraet: 'Pixel 7' },
  { name: '06-ipad-hoch',      maschine: 'webkit',   breite: 820,  hoehe: 1180, geraet: 'iPad (gen 7)' },
  { name: '07-ipad-quer',      maschine: 'webkit',   breite: 1180, hoehe: 820,  geraet: 'iPad (gen 7) landscape' },
  { name: '08-android-tablet', maschine: 'chromium', breite: 800,  hoehe: 1280, geraet: null },
  { name: '09-laptop',         maschine: 'chromium', breite: 1440, hoehe: 900,  geraet: null },
  { name: '10-schirm-gross',   maschine: 'chromium', breite: 1920, hoehe: 1080, geraet: null },
];

/* Einzelne Größen nachziehen, ohne alle zehn neu zu rendern:
   STELLIUM_GERAETE=01,04 node scripts/schirmbilder-vorschlaege.mjs
   Nützlich nach einer kleinen Änderung — und auf einem Rechner, dem der
   Platz ausgeht. */
const NUR = (process.env.STELLIUM_GERAETE ?? '').split(',').map((s) => s.trim()).filter(Boolean);
const AUSWAHL = NUR.length ? GERAETE.filter((g) => NUR.some((n) => g.name.startsWith(n))) : GERAETE;

fs.mkdirSync(ZIEL, { recursive: true });
const probe = await probeserver();
const maschinen = {};
for (const art of new Set(AUSWAHL.map((g) => g.maschine))) {
  maschinen[art] = await (art === 'webkit' ? webkit : chromium).launch({ headless: true });
}

console.log(`\nSchirmbilder des Vorschlag-Eingangs nach ${ZIEL}/\n`);
const befunde = [];

/** Was in den Karten steht — bewusst lang genug, um Umbrüche zu erzwingen. */
const BEISPIELE = [
  {
    art: 'aufgabe',
    titel: 'Angebot für Meier bis Freitag rausschicken und den Rabatt vorher mit der Buchhaltung klären',
    quelleText: 'Wir sollten das Angebot für Meier bis Freitag rausschicken. '
      + 'Den Rabatt müssten wir vorher noch mit der Buchhaltung klären, sonst wird das nichts.',
    // Eine Frist, damit die Karte auch die Zeile mit dem Termin zeigt.
    faelligAm: Date.now() + 3 * 86_400_000,
  },
  {
    art: 'idee',
    titel: 'Kundenfrühstück einmal im Quartal',
    quelleText: 'Was haltet ihr davon, einmal im Quartal ein Kundenfrühstück zu machen? '
      + 'Wäre viel lockerer als die üblichen Termine.',
  },
  {
    art: 'aufgabe',
    titel: 'Preisliste aktualisieren',
    quelleText: 'Und die Preisliste braucht dringend ein Update.',
  },
];

/* ── Einsaat auf dem Server ───────────────────────────────────────

   Früher wurden die Karten im Browser in den Laden gesetzt. Das hielt nur,
   solange der Gateway auf `vorschlag:list` nicht antwortete: seit er es tut,
   kommt nach jedem Öffnen die echte — leere — Liste und räumt die Beispiele
   weg. Man sah es nicht einmal, weil ein leerer Eingang ordentlich aussieht.

   Jetzt entstehen sie denselben Weg wie im Betrieb: echte Nachrichten, echte
   Kandidaten, echte Vorschläge in der Datenbank. Damit hält jedes Laden, und
   die Bilder zeigen, was Leute wirklich sehen. */
process.env.DATA_DIR = probe.datenordner;
const messages = await import('../packages/server/dist/services/messages.js');
const V = await import('../packages/server/dist/services/vorschlaege.js');

const saat = (() => {
  const roh = new DatabaseSync(probe.datenbank, { readOnly: true });
  const kanal = roh.prepare("SELECT id, name FROM channels WHERE kind = 'public' ORDER BY created_at LIMIT 1").get();
  const nutzer = roh.prepare('SELECT id FROM users ORDER BY created_at LIMIT 1').get();
  roh.close();
  return { kanal, nutzer };
})();

{
  const kandidaten = [];
  for (const b of BEISPIELE) {
    const msg = messages.createMessage({
      channelId: saat.kanal.id, userId: saat.nutzer.id, text: b.quelleText, parentId: null,
    });
    kandidaten.push({
      art: b.art, titel: b.titel, quelleMessageId: msg.id,
      genanntUserId: saat.nutzer.id, faelligAm: b.faelligAm ?? null,
    });
  }
  const bericht = V.kandidatenEintragen(saat.kanal.id, kandidaten);
  if (bericht.angelegt.length !== BEISPIELE.length) {
    throw new Error(`nur ${bericht.angelegt.length} von ${BEISPIELE.length} Vorschlägen angelegt `
      + `(${bericht.grund ?? 'kein Grund genannt'}) — ohne Karten sagt kein Bild etwas`);
  }
}

for (const g of AUSWAHL) {
  const geraet = g.geraet && devices[g.geraet] ? devices[g.geraet] : {};
  const ctx = await maschinen[g.maschine].newContext({
    ...geraet,
    viewport: { width: g.breite, height: g.hoehe },
    locale: 'de-DE',
    deviceScaleFactor: 2,
  });
  const p = await ctx.newPage();
  await p.goto(APP);
  await p.evaluate(([s, t]) => {
    localStorage.setItem('stellium.serverUrl', s);
    localStorage.setItem('stellium.token', t);
    localStorage.setItem('stellium.tourGesehen', 'ja');
  }, [probe.S, probe.token]);
  await p.reload();
  await p.waitForSelector('.app', { timeout: 20000 });
  await p.waitForTimeout(1400);

  /* Aufmachen — die Karten liegen schon in der Datenbank. */
  await p.evaluate(() => window.__stelliumVorschlaege.getState().oeffnen());
  await p.waitForSelector('.vorschlag', { timeout: 8000 });
  await p.waitForTimeout(700);

  const mangel = await p.evaluate(() => {
    const breite = document.documentElement.clientWidth;
    const raus = [];
    const abgeschnitten = (el) => {
      for (let v = el.parentElement; v && v !== document.body; v = v.parentElement) {
        const st = getComputedStyle(v);
        if (st.overflowX !== 'visible' || st.contain.includes('strict')) return true;
      }
      return false;
    };
    for (const el of document.querySelectorAll('.panel *')) {
      const st = getComputedStyle(el);
      if (st.visibility === 'hidden' || st.display === 'none') continue;
      const r = el.getBoundingClientRect();
      if (r.width === 0 || r.height === 0) continue;
      if (r.right <= breite + 1 && r.left >= -1) continue;
      if (abgeschnitten(el)) continue;
      raus.push(`${el.tagName.toLowerCase()}.${(el.className || '').toString().split(' ')[0]}`);
    }

    /* Ein Knopf, den man auf dem Telefon nicht trifft, ist kein Knopf. 40 px
       ist die Untergrenze, mit der hier gerechnet wird — siehe app.css. */
    const zuKlein = [...document.querySelectorAll('.vorschlag__knoepfe .btn')]
      .filter((b) => b.getBoundingClientRect().height < 39)
      .map((b) => b.textContent.trim());

    return {
      ueberlauf: document.documentElement.scrollWidth - document.documentElement.clientWidth,
      raus: [...new Set(raus)].slice(0, 3),
      zuKlein: [...new Set(zuKlein)],
      karten: document.querySelectorAll('.vorschlag').length,
    };
  });

  /* `animations: 'disabled'` friert die laufenden Übergänge ein. Ohne das
     wartet Playwright auf einen Ruhezustand, den der Sternenhimmel im
     Hintergrund nie erreicht — der Lauf blieb hier bei 30 s hängen. */
  await p.screenshot({ path: `${ZIEL}/${g.name}.png`, animations: 'disabled', caret: 'hide', timeout: 60000 });

  // Und einmal mit aufgeklapptem Änderungsbereich — dort steckt das Formular.
  await p.locator('.vorschlag__knoepfe .btn--ghost').first().click();
  /* Nicht auf „sichtbar" warten: der Bereich klappt über die Höhe auf, und
     bei 0 px gilt er als unsichtbar — der Lauf lief hier in die Frist. */
  await p.waitForFunction(
    () => (document.querySelector('.vorschlag__aendern')?.clientHeight ?? 0) > 80,
    null, { timeout: 8000 },
  );
  await p.waitForTimeout(700);
  await p.screenshot({ path: `${ZIEL}/${g.name}-aendern.png`, animations: 'disabled', caret: 'hide', timeout: 60000 });

  /* Einmal auch die beiden Türen an den Brettern. Sie stehen in
     TasksBoard/IdeaBoard und führen vorgefiltert in denselben Eingang —
     Dons „jeweils". Nur auf einer Größe: sie gehören zur Brettleiste, nicht
     zum Eingang, und was dort klemmt, klemmt überall.

     Zwischen den Brettern wird aufgeräumt. Fenster liegen sonst übereinander
     im Baum, `.first()` greift das unterste, und der Klick geht ins Fenster
     darüber statt auf den Knopf. */
  if (g.name === '09-laptop') {
    await p.evaluate(() => window.__stelliumVorschlaege.getState().schliessen());

    for (const [brett, art] of [['tasks', 'aufgabe'], ['ideas', 'idee']]) {
      await p.evaluate((b) => window.__stelliumStore.getState().setOverlay(b), brett);
      await p.waitForFunction(() => document.querySelectorAll('.panel__head').length === 1,
        null, { timeout: 8000 });

      const tuer = p.locator('.panel__head .pill:has-text("Vorschläge")').first();
      await tuer.waitFor({ state: 'visible', timeout: 8000 });
      await p.screenshot({
        path: `${ZIEL}/tuer-${brett}.png`, animations: 'disabled', caret: 'hide', timeout: 60000,
      });

      await tuer.click();
      // Sie muss vorgefiltert aufmachen — sonst wäre sie nur ein zweiter Weg
      // in dieselbe unsortierte Liste.
      await p.waitForFunction(
        (a) => window.__stelliumVorschlaege.getState().offen === a, art, { timeout: 5000 },
      );
      console.log(`  ✓ Tür am Brett ${brett} führt gefiltert in den Eingang (${art})`);

      await p.evaluate(() => {
        window.__stelliumVorschlaege.getState().schliessen();
        window.__stelliumStore.getState().setOverlay(null);
      });
      await p.waitForFunction(() => document.querySelectorAll('.panel__head').length === 0,
        null, { timeout: 8000 });
    }
    await p.evaluate(() => window.__stelliumVorschlaege.getState().oeffnen());
    await p.waitForSelector('.vorschlag', { timeout: 8000 });

    /* Bleibt der Fokus im Fenster? Der Eingang baut keine eigene Falle — er
       benutzt Shell, und Shell hängt an useFokusfalle. Geprüft wird das
       trotzdem: „benutzt dieselbe Vorrichtung" ist eine Behauptung über den
       Bauplan, nicht über das Verhalten. Bei der Schnellsuche landeten
       vorher 19 von 25 Sprüngen hinter dem Fenster. */
    // Nicht klicken — der Vorhang fängt den Zeiger ab. Die Falle setzt den
    // Fokus beim Öffnen ohnehin ins Fenster; von dort wird getabbt.
    const entwischt = [];
    const drin = new Set();
    for (let i = 0; i < 25; i++) {
      await p.keyboard.press('Tab');
      const wo = await p.evaluate(() => {
        const fenster = document.querySelector('.panel');
        const jetzt = document.activeElement;
        if (!fenster || !jetzt || jetzt === document.body) return { art: 'nirgends' };
        const name = `${jetzt.tagName.toLowerCase()}.${(jetzt.className || '').toString().split(' ')[0]}`;
        return { art: fenster.contains(jetzt) ? 'drin' : 'draussen', name };
      });
      if (wo.art === 'draussen') entwischt.push(wo.name);
      if (wo.art === 'drin') drin.add(wo.name);
    }
    /* Ohne diese Zeile wäre die Prüfung blind: bewegt sich der Fokus gar
       nicht, entwischt auch nichts, und alles sähe bestens aus. */
    if (drin.size < 2) befunde.push(`Der Fokus wandert nicht (${drin.size} Ziele) — die Prüfung sagt nichts aus`);
    if (entwischt.length) {
      befunde.push(`Fokus verlässt den Eingang bei ${entwischt.length} von 25 Sprüngen: `
        + [...new Set(entwischt)].join(', '));
    } else {
      console.log(`  ✓ Der Fokus bleibt im Eingang — 25 Sprünge über ${drin.size} Ziele`);
    }
  }

  const gut = mangel.ueberlauf <= 1 && !mangel.raus.length && !mangel.zuKlein.length && mangel.karten === 3;
  console.log(`  ${gut ? '✓' : '✗'} ${g.name.padEnd(20)} ${g.breite}×${g.hoehe} ${g.maschine.padEnd(9)}`
    + ` ${mangel.karten} Karten`
    + (mangel.ueberlauf > 1 ? ` — ${mangel.ueberlauf}px zu breit` : '')
    + (mangel.raus.length ? ` — ragt heraus: ${mangel.raus.join(', ')}` : '')
    + (mangel.zuKlein.length ? ` — zu kleine Knöpfe: ${mangel.zuKlein.join(', ')}` : ''));
  if (!gut) befunde.push(g.name);
  await ctx.close();
}

for (const m of Object.values(maschinen)) await m.close();
await probe.stop();
console.log(`\n${AUSWAHL.length - befunde.length}/${AUSWAHL.length} ohne Beanstandung`);
process.exit(befunde.length ? 1 : 0);
