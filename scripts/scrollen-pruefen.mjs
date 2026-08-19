/**
 * Kann Don die Seite unten wegziehen?
 *
 * Zwei ganz verschiedene Dinge sehen mit dem Finger gleich aus, und nur eines
 * davon ist echtes Scrollen:
 *
 *   a) Das Dokument ist HÖHER als das Fenster. Dann bleibt es weggezogen
 *      stehen — es schnappt NICHT zurück.
 *   b) Das Dokument passt genau, aber iOS spannt es an den Rändern elastisch
 *      nach (Gummiband). Dann schnappt es zurück, sobald der Finger loslässt.
 *
 * Don sagt: „ich kann es weiter runter ziehen, es geht aber wieder hoch."
 * Das „wieder hoch" ist der Unterschied — es ist (b), nicht (a). Gegen (b)
 * hilft kein Aufräumen der Höhen, sondern overscroll-behavior am Wurzelelement.
 *
 * Diese Prüfung stellt beides fest, in beiden Maschinen, mit ECHTEN
 * Geräterändern, wo die Maschine das kann:
 *   1. Ist das Dokument höher als das Fenster? (Fall a)
 *   2. Steht am Wurzelelement die Bremse gegen das Gummiband? (Fall b)
 *
 * Aufruf:  node scripts/scrollen-pruefen.mjs
 */
import { chromium, webkit, devices } from 'playwright';
import { probeserver } from './probeserver.mjs';

const APP = process.env.STELLIUM_APP ?? 'http://localhost:5173';
const RAENDER = { top: 59, bottom: 34, left: 0, right: 0 };

async function probeserverMitAnlaeufen(versuche = 8) {
  let letzter;
  for (let n = 0; n < versuche; n += 1) {
    try { return await probeserver(); } catch (f) { letzter = f; await new Promise((r) => setTimeout(r, 400)); }
  }
  throw letzter;
}

const probe = await probeserverMitAnlaeufen();
const maschinen = [
  { name: 'WebKit (Safari, iOS)', starten: () => webkit.launch({ headless: true }), geraet: 'iPhone 15 Pro', echteRaender: false },
  { name: 'Chromium',             starten: () => chromium.launch({ headless: true }), geraet: 'Pixel 7',      echteRaender: true },
];

const zeilen = [];
let fehler = 0;

for (const m of maschinen) {
  const b = await m.starten();
  const ctx = await b.newContext({
    ...devices[m.geraet],
    viewport: { width: 402, height: 874 },   // iPhone 16/17 Pro in Punkten
    deviceScaleFactor: 1,
    locale: 'de-DE',
  });
  const p = await ctx.newPage();

  /* Chromium kann echte Geräteränder einstellen — dann rechnet env() wirklich,
     statt dass die Merkmale von Hand gesetzt werden. WebKit kann das nicht;
     dort werden die Merkmale nachgestellt. Beides steht im Bericht. */
  let art = 'Merkmale nachgestellt';
  if (m.echteRaender) {
    try {
      await (await ctx.newCDPSession(p)).send('Emulation.setSafeAreaInsetsOverride', { insets: RAENDER });
      art = 'echte env()-Ränder';
    } catch { /* dann eben nachgestellt */ }
  }

  await p.goto(APP);
  await p.evaluate(([s, t]) => {
    localStorage.setItem('stellium.serverUrl', s);
    localStorage.setItem('stellium.token', t);
    localStorage.setItem('stellium.tourGesehen', 'ja');
  }, [probe.S, probe.token]);
  await p.reload();
  await p.waitForSelector('.app', { timeout: 20000 });
  if (art !== 'echte env()-Ränder') {
    await p.addStyleTag({ content: `:root { --sicher-oben: ${RAENDER.top}px; --sicher-unten: ${RAENDER.bottom}px; --sicher-links: 0px; --sicher-rechts: 0px; }` });
  }
  await p.waitForTimeout(900);

  const mass = await p.evaluate(() => {
    const de = document.documentElement, bd = document.body;
    const probier = (el) => { const v = el.scrollTop; el.scrollTop = 400; const n = el.scrollTop; el.scrollTop = v; return n; };
    const vor = window.scrollY; window.scrollTo(0, 400); const nach = window.scrollY; window.scrollTo(0, vor);

    /* Nur Kästen im Fluss zählen für die Dokumenthöhe. Fest oder absolut
       positionierte Flächen (der Sternenhimmel ragt mit Absicht hinaus)
       schieben das Dokument nicht auf. */
    const zuTief = [];
    for (const el of document.querySelectorAll('*')) {
      const r = el.getBoundingClientRect();
      if (!r.height && !r.width) continue;
      const s = getComputedStyle(el);
      if (s.position === 'fixed' || s.position === 'absolute') continue;
      const ueber = r.bottom - window.innerHeight;
      if (ueber > 0.5) zuTief.push({ wahl: `${el.tagName.toLowerCase()}.${(el.className || '').toString().trim().split(/\s+/)[0]}`, ueber: Math.round(ueber * 10) / 10, cssHoehe: s.height, padUnten: s.paddingBottom });
    }

    return {
      innerHeight: window.innerHeight,
      sicherUnten: getComputedStyle(de).getPropertyValue('--sicher-unten').trim(),
      htmlUeberschuss: de.scrollHeight - de.clientHeight,
      bodyUeberschuss: bd.scrollHeight - bd.clientHeight,
      bewegt: Math.max(nach, probier(de), probier(bd)),
      bremseHtml: getComputedStyle(de).overscrollBehaviorY || getComputedStyle(de).overscrollBehavior,
      bremseBody: getComputedStyle(bd).overscrollBehaviorY || getComputedStyle(bd).overscrollBehavior,
      /* Die Tastatur lässt sich hier nicht aufmachen — geprüft wird deshalb
         nur, dass die Angabe überhaupt noch dasteht. Das fängt wenigstens ab,
         dass sie jemand versehentlich wieder herausnimmt. */
      tastaturAngabe: (document.querySelector('meta[name=viewport]')?.content ?? '').includes('interactive-widget=resizes-content'),
      zuTief: zuTief.sort((a, b2) => b2.ueber - a.ueber).slice(0, 8),

      /* Die Bremse am Wurzelelement darf die Nachrichtenliste nicht mit
         anhalten — sie ist das Einzige, was scrollen SOLL. Geprüft mit einem
         Klotz, der hineingelegt und danach wieder entfernt wird. */
      listeScrollt: (() => {
        const st = document.querySelector('.stream');
        if (!st) return null;
        const klotz = document.createElement('div');
        klotz.style.height = '2000px';
        st.appendChild(klotz);
        st.scrollTop = 500;
        const kam = st.scrollTop;
        klotz.remove();
        st.scrollTop = 0;
        return kam;
      })(),

      /* Sitzt das Schreibfeld über der Home-Leiste, nicht darunter? */
      composerLuft: (() => {
        const c = document.querySelector('.composer');
        if (!c) return null;
        return Math.round(window.innerHeight - c.getBoundingClientRect().bottom);
      })(),
    };
  });

  await b.close();

  /* Fall a — echtes Überlaufen. Darf nicht sein. */
  const laeuftUeber = mass.htmlUeberschuss > 0 || mass.bodyUeberschuss > 0 || mass.bewegt > 0 || mass.zuTief.length > 0;
  /* Fall b — Gummiband. Nur „none" hält es an; „contain" verhindert nur das
     Durchreichen an das Fenster, nicht das Nachfedern des Fensters selbst. */
  const gebremst = mass.bremseHtml === 'none';

  if (laeuftUeber) fehler += 1;
  if (!gebremst) fehler += 1;
  if (!mass.tastaturAngabe) fehler += 1;

  const listeGut = mass.listeScrollt !== null && mass.listeScrollt > 400;
  const noetig = parseInt(mass.sicherUnten, 10) || 0;
  const composerGut = mass.composerLuft !== null && mass.composerLuft >= noetig;
  if (!listeGut) fehler += 1;
  if (!composerGut) fehler += 1;

  console.log(`\n╔═══ ${m.name} ═══ ${art}`);
  console.log(`║ innerHeight ${mass.innerHeight}   --sicher-unten ${mass.sicherUnten}`);
  console.log(`║`);
  console.log(`║ a) Ist das Dokument höher als das Fenster?`);
  console.log(`║      html-Überschuss ${mass.htmlUeberschuss} px   body-Überschuss ${mass.bodyUeberschuss} px   wirklich bewegt ${mass.bewegt} px`);
  if (mass.zuTief.length) for (const z of mass.zuTief) console.log(`║      ragt ${z.ueber} px hinaus: ${z.wahl} (Höhe ${z.cssHoehe}, pad-unten ${z.padUnten})`);
  console.log(laeuftUeber ? '║      ✗ Es läuft über — das bliebe weggezogen stehen.' : '║      ✓ Kein Überlaufen. Nichts könnte stehen bleiben.');
  console.log(`║`);
  console.log(`║ b) Bremse gegen das Gummiband (overscroll-behavior)?`);
  console.log(`║      html „${mass.bremseHtml}"   body „${mass.bremseBody}"`);
  console.log(gebremst ? '║      ✓ Am Wurzelelement steht none — das Fenster federt nicht mehr nach.'
                       : `║      ✗ Am Wurzelelement steht „${mass.bremseHtml}" — iOS spannt die Seite elastisch nach und lässt sie zurückschnappen. GENAU DAS beschreibt Don.`);
  console.log(`║`);
  console.log(`║ c) Angabe für die Tastatur in der Viewport-Zeile?`);
  console.log(mass.tastaturAngabe
    ? '║      ✓ interactive-widget=resizes-content steht da (Wirkung mit echter Tastatur ungeprüft).'
    : '║      ✗ interactive-widget=resizes-content fehlt — dann verschiebt iOS beim Tippen die ganze Seite.');
  console.log(`║`);
  console.log(`║ d) Scrollt die Nachrichtenliste noch?  ${mass.listeScrollt} px von 500 gewollt`);
  console.log(listeGut ? '║      ✓ Ja — die Bremse hält nur das Fenster an, nicht die Liste.'
                       : '║      ✗ Nein — die Bremse hat die Liste mit angehalten.');
  console.log(`║ e) Luft zwischen Schreibfeld und unterem Rand: ${mass.composerLuft} px (nötig ${noetig} px)`);
  console.log(composerGut ? '║      ✓ Das Schreibfeld sitzt über der Home-Leiste.'
                          : '║      ✗ Das Schreibfeld rutscht unter die Home-Leiste.');
  zeilen.push({ maschine: m.name, laeuftUeber, gebremst, tastatur: mass.tastaturAngabe, liste: listeGut, composer: composerGut });
}

await probe.stop();
console.log('');
for (const z of zeilen) console.log(`  ${z.maschine.padEnd(22)} Überlaufen ${z.laeuftUeber ? '✗' : '✓'}   Gummiband gebremst ${z.gebremst ? '✓' : '✗'}   Tastatur-Angabe ${z.tastatur ? '✓' : '✗'}   Liste scrollt ${z.liste ? '✓' : '✗'}   Composer frei ${z.composer ? '✓' : '✗'}`);
console.log(fehler ? `\n✗ ${fehler} Beanstandung(en).\n` : '\n✓ Das Dokument steht fest und federt nicht nach.\n');
process.exit(fehler ? 1 : 0);
