/**
 * Lässt sich das Dokument wegziehen, wo es nicht dürfte?
 *
 * Don kann die Seite unten anfassen und ein Stück herunterziehen; sie schnappt
 * zurück. Das ist kein Farbfehler, sondern Bewegung im Dokument: irgendeine
 * Box ist höher als das Fenster. Gemessen wird deshalb nicht, wie es aussieht,
 * sondern wie hoch die Kästen wirklich sind — mit ECHTEN Geräterändern über
 * Emulation.setSafeAreaInsetsOverride, denn nur dann rechnet env() so wie auf
 * dem iPhone, und nur dann taucht ein Fehler auf, der an env() hängt.
 *
 * Geprüft wird zusätzlich als Web-App vom Startbildschirm (display-mode:
 * standalone) — Don benutzt sie so, und dort gelten andere Ränder als im
 * Browser.
 *
 * Aufruf:  node scripts/scrollen-messen.mjs
 */
import { chromium, devices } from 'playwright';
import { probeserver } from './probeserver.mjs';

const APP = process.env.STELLIUM_APP ?? 'http://localhost:5173';

async function probeserverMitAnlaeufen(versuche = 8) {
  let letzter;
  for (let n = 0; n < versuche; n += 1) {
    try { return await probeserver(); } catch (f) { letzter = f; await new Promise((r) => setTimeout(r, 400)); }
  }
  throw letzter;
}

const FAELLE = [
  { name: 'Browser, ohne Geräteränder', raender: null,                                 anzeige: 'browser' },
  { name: 'Browser, Ränder 59/34',      raender: { top: 59, bottom: 34, left: 0, right: 0 }, anzeige: 'browser' },
  { name: 'Web-App, Ränder 59/34',      raender: { top: 59, bottom: 34, left: 0, right: 0 }, anzeige: 'standalone' },
];

const probe = await probeserverMitAnlaeufen();
const b = await chromium.launch({ headless: true });
const berichte = [];

for (const fall of FAELLE) {
  const ctx = await b.newContext({
    ...devices['Pixel 7'],
    viewport: { width: 402, height: 874 },   // iPhone 16/17 Pro in Punkten
    deviceScaleFactor: 1,
    locale: 'de-DE',
  });
  const p = await ctx.newPage();
  const cdp = await ctx.newCDPSession(p);

  let raenderEcht = false;
  if (fall.raender) {
    try { await cdp.send('Emulation.setSafeAreaInsetsOverride', { insets: fall.raender }); raenderEcht = true; }
    catch (f) { console.log(`⚠ Ränder gehen nicht: ${f.message.split('\n')[0]}`); }
  }
  let anzeigeEcht = false;
  if (fall.anzeige === 'standalone') {
    try {
      await cdp.send('Emulation.setEmulatedMedia', { features: [{ name: 'display-mode', value: 'standalone' }] });
      anzeigeEcht = true;
    } catch (f) { console.log(`⚠ Anzeigeart geht nicht: ${f.message.split('\n')[0]}`); }
  }

  await p.goto(APP);
  await p.evaluate(([s, t]) => {
    localStorage.setItem('stellium.serverUrl', s);
    localStorage.setItem('stellium.token', t);
    localStorage.setItem('stellium.tourGesehen', 'ja');
  }, [probe.S, probe.token]);
  await p.reload();
  await p.waitForSelector('.app', { timeout: 20000 });
  await p.waitForTimeout(900);

  const mass = await p.evaluate(() => {
    const de = document.documentElement, bd = document.body;
    const w = getComputedStyle(de);

    /* Der eigentliche Beweis: wirklich versuchen zu scrollen. scrollHeight
       allein kann täuschen — erst wenn scrollTop tatsächlich stehen bleibt,
       gibt es Bewegung, die der Finger spürt. */
    const probierScrollen = (el) => {
      const vorher = el.scrollTop;
      el.scrollTop = 400;
      const nachher = el.scrollTop;
      el.scrollTop = vorher;
      return nachher;
    };
    const fensterVorher = window.scrollY;
    window.scrollTo(0, 400);
    const fensterNachher = window.scrollY;
    window.scrollTo(0, fensterVorher);

    /* Jede Box suchen, die unter den Fensterrand reicht. Fest positionierte
       Flächen mit Absicht (der Sternenhimmel) werden benannt, nicht versteckt. */
    const zuTief = [];
    for (const el of document.querySelectorAll('*')) {
      const r = el.getBoundingClientRect();
      if (r.height === 0 && r.width === 0) continue;
      const ueber = r.bottom - window.innerHeight;
      if (ueber > 0.5) {
        const s = getComputedStyle(el);
        zuTief.push({
          wahl: `${el.tagName.toLowerCase()}${el.className && typeof el.className === 'string' ? '.' + el.className.trim().split(/\s+/).join('.') : ''}`.slice(0, 52),
          ueber: Math.round(ueber * 10) / 10,
          oben: Math.round(r.top), hoehe: Math.round(r.height),
          pos: s.position,
          cssHoehe: s.height,
          padUnten: s.paddingBottom,
          boxSizing: s.boxSizing,
        });
      }
    }
    zuTief.sort((a, b2) => b2.ueber - a.ueber);

    return {
      innerHeight: window.innerHeight,
      visual: window.visualViewport ? Math.round(window.visualViewport.height) : null,
      sicherOben: w.getPropertyValue('--sicher-oben').trim(),
      sicherUnten: w.getPropertyValue('--sicher-unten').trim(),
      standalone: window.matchMedia('(display-mode: standalone)').matches,
      html: {
        scrollHeight: de.scrollHeight, clientHeight: de.clientHeight,
        overflow: getComputedStyle(de).overflow, gescrollt: probierScrollen(de),
      },
      body: {
        scrollHeight: bd.scrollHeight, clientHeight: bd.clientHeight,
        overflow: getComputedStyle(bd).overflow, gescrollt: probierScrollen(bd),
      },
      fensterGescrollt: fensterNachher,
      zuTief: zuTief.slice(0, 14),
    };
  });

  berichte.push({ fall, raenderEcht, anzeigeEcht, mass });
  await ctx.close();
}

await b.close();
await probe.stop();

let schlecht = 0;
for (const b2 of berichte) {
  const m = b2.mass;
  const ueberschussHtml = m.html.scrollHeight - m.html.clientHeight;
  const ueberschussBody = m.body.scrollHeight - m.body.clientHeight;
  const beweglich = m.fensterGescrollt > 0 || m.html.gescrollt > 0 || m.body.gescrollt > 0;
  if (beweglich) schlecht += 1;

  console.log(`\n╔═══ ${b2.fall.name} ═══`);
  console.log(`║ Ränder echt: ${b2.raenderEcht ? 'ja' : 'nein'}   display-mode: standalone → ${m.standalone ? 'JA' : 'nein'}`);
  console.log(`║ innerHeight ${m.innerHeight}   visualViewport ${m.visual}   --sicher-oben ${m.sicherOben}   --sicher-unten ${m.sicherUnten}`);
  console.log('║');
  console.log(`║ html   scrollHeight ${String(m.html.scrollHeight).padStart(5)}  clientHeight ${String(m.html.clientHeight).padStart(5)}  Überschuss ${String(ueberschussHtml).padStart(4)}  overflow ${m.html.overflow}`);
  console.log(`║ body   scrollHeight ${String(m.body.scrollHeight).padStart(5)}  clientHeight ${String(m.body.clientHeight).padStart(5)}  Überschuss ${String(ueberschussBody).padStart(4)}  overflow ${m.body.overflow}`);
  console.log(`║`);
  console.log(`║ Wirklich weggezogen?  window ${m.fensterGescrollt} px   html ${m.html.gescrollt} px   body ${m.body.gescrollt} px`);
  console.log(beweglich
    ? `║   ✗ Das Dokument BEWEGT sich — genau das spürt der Finger.`
    : `║   ✓ Das Dokument steht fest.`);
  console.log('║');
  console.log(`║ Kästen, die unter den Fensterrand reichen (${m.zuTief.length}):`);
  if (!m.zuTief.length) console.log('║   — keine —');
  for (const z of m.zuTief) {
    console.log(`║   +${String(z.ueber).padStart(6)} px  ${z.wahl.padEnd(40)} pos ${z.pos.padEnd(8)} Höhe ${String(z.hoehe).padStart(5)} (css ${z.cssHoehe.padEnd(9)}) pad-unten ${z.padUnten.padEnd(7)} ${z.boxSizing}`);
  }
}

console.log(schlecht
  ? `\n✗ In ${schlecht} von ${berichte.length} Fällen lässt sich das Dokument bewegen.\n`
  : `\n✓ In keinem Fall lässt sich das Dokument bewegen.\n`);
process.exit(schlecht ? 1 : 0);
