/**
 * Welcher Teil der Oberfläche kostet wie viel? — Werkzeug, kein Prüflauf.
 *
 * Die Gesamtmessung sagt „zäh". Sie sagt nicht, woran es liegt. Hier wird
 * deshalb ein Teil nach dem anderen ABGESCHALTET und neu gemessen: was die
 * Zahl verbessert, war die Ursache; was sie nicht anrührt, war es nicht.
 *
 * Bewusst ein eigenes Werkzeug und nicht in fluessig-messen.mjs: das dort ist
 * der Wächter gegen Rückschritte und muss stabil bleiben. Das hier wird beim
 * Suchen umgebaut.
 *
 * ZWEI WARNUNGEN, beide teuer bezahlt:
 *
 *   1. Dieses Werkzeug misst den ENTWICKLUNGSSERVER, weil es den Verlauf über
 *      `window.__stelliumStore` hinlegt und den Haken nur dort gibt. Unter Vite
 *      läuft React aber in der Entwicklungsfassung: im Profil des Tippens stand
 *      `jsxDEV` mit 1,64 ms je Anschlag ganz oben, im fertigen Bau sind es 0,15.
 *      Die Anteile hier sind also brauchbar, die absoluten Zahlen nicht.
 *      Wer absolute Zahlen braucht, nimmt fluessig-messen.mjs.
 *
 *   2. Ohne --gpu rastert Chromium über SwiftShader auf der CPU. Das ist eine
 *      brauchbare Näherung für eine Maschine ohne Grafikbeschleunigung — aber
 *      es ist NICHT der Mac und nicht ein Telefon. Der Weichzeichner im
 *      Hintergrund sah hier nach dem größten Posten der ganzen Oberfläche aus
 *      und kostet mit Grafikkarte exakt nichts. Immer beides messen.
 *
 * Aufruf:  node scripts/fluessig-zerlegen.mjs [--profil Handy] [--gpu] [--sichtbar]
 */
import { execFileSync } from 'node:child_process';
import { chromium } from 'playwright';
import { probeserver } from './probeserver.mjs';

const APP = process.env.STELLIUM_APP ?? 'http://localhost:5173';
const arg = (n) => { const i = process.argv.indexOf(n); return i > -1 ? process.argv[i + 1] : null; };
const PROFILNAME = arg('--profil') ?? 'Laptop';
const SICHTBAR = process.argv.includes('--sichtbar');
/* Ohne Fenster rastert Chromium mit SwiftShader, also auf der CPU. Das ist
   nicht falsch, sondern eine gute Näherung für ein Telefon — aber es ist NICHT
   der Mac. Mit --gpu läuft dieselbe Messung über Metal auf der echten
   Grafikkarte. Beide Zahlen zusammen sagen erst die Wahrheit. */
const GPU = process.argv.includes('--gpu');

const PROFILE = {
  Laptop: { breite: 1440, hoehe: 900, bremse: 1 },
  Handy: { breite: 390, hoehe: 844, bremse: 4 },
};
const profil = PROFILE[PROFILNAME];

/* Jeder Versuch schaltet genau eine Sache ab. Die Reihenfolge ist bewusst
   „einzeln, dann zusammen": erst sieht man die Anteile, dann ob sie sich
   addieren oder einander verdecken. */
const VERSUCHE = [
  { name: 'wie es ist', css: '' },
  { name: 'Blasen ohne scale', css: '@keyframes drift-a{to{transform:translate3d(-9vw,8vh,0)}}@keyframes drift-b{to{transform:translate3d(11vw,-7vh,0)}}@keyframes drift-c{to{transform:translate3d(-13vw,-11vh,0)}}' },
  { name: 'Blasen stehen still', css: '.cosmos__blob{animation:none!important}' },
  { name: 'Blasen ganz weg', css: '.cosmos__blob{display:none!important}' },
  { name: 'Sternenfeld weg', css: '.cosmos__stars{display:none!important}' },
  { name: 'Sterne: rAF aus', js: 'stern-raf-aus' },
  { name: 'backdrop-filter aus', css: '*{backdrop-filter:none!important;-webkit-backdrop-filter:none!important}' },
  { name: 'Blasen still + backdrop aus', css: '.cosmos__blob{animation:none!important}*{backdrop-filter:none!important;-webkit-backdrop-filter:none!important}' },
  { name: 'ganzer Hintergrund weg', css: '.cosmos{display:none!important}' },
  { name: 'Hintergrund weg + backdrop aus', css: '.cosmos{display:none!important}*{backdrop-filter:none!important;-webkit-backdrop-filter:none!important}' },
  /* Der Verlauf in den Blasen läuft ohnehin schon bei 68 % auf durchsichtig
     aus — er ist weich, bevor irgendein Weichzeichner dazukommt. Also: was
     kostet der Weichzeichner, und was bliebe ohne ihn übrig? */
  { name: 'Blasen ohne filter:blur', css: '.cosmos__blob{filter:none!important}' },
  { name: 'Blasen blur(24px)', css: '.cosmos__blob{filter:blur(24px)!important}' },
  { name: 'Blasen ohne blur, ohne will-change', css: '.cosmos__blob{filter:none!important;will-change:auto!important}' },
];

const sekunden = (s) => s.split(':').map(Number).reduce((a, b) => a * 60 + b, 0);
function cpuBaum(wurzel) {
  const zeit = new Map(); const kinder = new Map();
  for (const z of execFileSync('ps', ['-eo', 'pid=,ppid=,time=']).toString().split('\n')) {
    const m = /^\s*(\d+)\s+(\d+)\s+(\S+)\s*$/.exec(z);
    if (!m) continue;
    const pid = Number(m[1]); const ppid = Number(m[2]);
    zeit.set(pid, sekunden(m[3]));
    if (!kinder.has(ppid)) kinder.set(ppid, []);
    kinder.get(ppid).push(pid);
  }
  let summe = 0; const stapel = [wurzel];
  while (stapel.length) { const p = stapel.pop(); summe += zeit.get(p) ?? 0; for (const k of kinder.get(p) ?? []) stapel.push(k); }
  return summe;
}
const rund = (x, n = 1) => Math.round(x * 10 ** n) / 10 ** n;

function bilder(ts) {
  if (ts.length < 3) return { fps: 0, laengstes: 0, lahm: 0, anzahl: ts.length };
  const ab = ts.slice(1).map((t, i) => t - ts[i]);
  return {
    anzahl: ts.length,
    fps: rund((ab.length / (ts[ts.length - 1] - ts[0])) * 1000),
    laengstes: rund(Math.max(...ab)),
    lahm: ab.filter((d) => d > 32).length,
  };
}

const probe = await probeserver();
const server = await chromium.launchServer({
  headless: !SICHTBAR,
  args: GPU ? ['--use-angle=metal', '--enable-gpu-rasterization', '--ignore-gpu-blocklist'] : [],
});
const browser = await chromium.connect(server.wsEndpoint());
const pid = server.process().pid;

console.log(`\n  ${PROFILNAME} ${profil.breite}×${profil.hoehe}${profil.bremse > 1 ? `, CPU ${profil.bremse}× gebremst` : ''}   —   ${SICHTBAR ? 'mit Fenster (echte Grafik)' : 'ohne Fenster'}\n`);
console.log('  Versuch                          Leerlauf            Scrollen                     Tippen');
console.log('                                   fps   CPU%          fps  lahm  Stil   CPU%        ms   Layouts');
console.log('  ' + '─'.repeat(96));

for (const v of VERSUCHE) {
  const ctx = await browser.newContext({
    viewport: { width: profil.breite, height: profil.hoehe },
    deviceScaleFactor: 2, locale: 'de-DE', hasTouch: profil.breite < 700,
  });
  const p = await ctx.newPage();
  const cdp = await ctx.newCDPSession(p);
  await cdp.send('Performance.enable');
  await p.goto(APP);
  await p.evaluate(([s, t]) => {
    localStorage.setItem('stellium.serverUrl', s);
    localStorage.setItem('stellium.token', t);
    localStorage.setItem('stellium.tourGesehen', 'ja');
  }, [probe.S, probe.token]);
  await p.reload();
  await p.waitForSelector('.app', { timeout: 25000 });
  await p.waitForTimeout(1400);

  await p.evaluate((anzahl) => {
    const store = window.__stelliumStore;
    const s = store.getState();
    const kanal = s.activeChannelId;
    const selfId = s.self.id;
    const users = { ...s.users };
    const autoren = [selfId];
    for (let i = 0; i < 4; i += 1) {
      const id = `probe-user-${i}`;
      users[id] = {
        id, handle: `probe${i}`, displayName: ['Mara Feldmann', 'Tomás Ribeiro', 'Yuki Tanaka', 'Anna Kowalska'][i],
        email: `p${i}@probe.test`, avatarColor: '#7c5cff', avatarUrl: null, title: null,
        timezone: 'Europe/Berlin', language: 'de', autoTranslate: true, status: 'online',
        statusEmoji: null, statusText: null, statusExpiresAt: null, lastSeenAt: Date.now(),
        role: 'member', disabled: false, createdAt: 1,
      };
      autoren.push(id);
    }
    const texte = [
      'Der Entwurf für die neue Preisliste liegt jetzt im Ordner — schaut ihn euch bitte bis Freitag an.',
      'Kurze Rückfrage zur Lieferung nächste Woche: bleibt der Termin am Dienstag?',
      'Passt', 'Danke dir!',
      'Ich habe die Zahlen aus dem Quartalsbericht noch einmal nachgerechnet. Zwei Positionen waren doppelt.',
    ];
    const jetzt = Date.now();
    const liste = [];
    for (let i = 0; i < anzahl; i += 1) {
      liste.push({
        id: `probe-msg-${i}`, channelId: kanal, userId: autoren[Math.floor(i / 2) % autoren.length],
        parentId: null, text: texte[i % texte.length], sourceLang: 'de',
        createdAt: jetzt - (anzahl - i) * 61000, editedAt: null, deletedAt: null, systemKind: null,
        attachments: [], reactions: i % 9 === 0 ? [{ emoji: '👍', userIds: [selfId] }] : [],
        replyCount: 0, lastReplyAt: null, threadParticipantIds: [], mentionUserIds: [],
        pinned: false, kind: 'text', forwardedFrom: null, poll: null, voice: null, links: [],
        translation: i % 3 === 0 ? { lang: 'de', text: texte[(i + 2) % texte.length], provider: 'groq', model: 'p', confidence: 0.8, cached: true, unuebersetzt: false } : null,
      });
    }
    store.setState({ users, messages: { ...s.messages, [kanal]: liste }, hasMore: { ...s.hasMore, [kanal]: false } });
  }, 120);
  await p.waitForTimeout(1100);

  if (v.css) await p.addStyleTag({ content: v.css });
  if (v.js === 'stern-raf-aus') {
    await p.evaluate(() => { const f = window.requestAnimationFrame; window.requestAnimationFrame = (cb) => (cb.toString().includes('twinkle') ? 0 : f(cb)); });
    // Der laufende Kreisel muss auch weg — er hängt am alten rAF.
    await p.evaluate(() => { const c = document.querySelector('.cosmos__stars'); if (c) c.remove(); });
  }

  await p.evaluate(() => {
    const s = document.querySelector('.stream'); if (s) s.scrollTop = s.scrollHeight;
    const m = { ts: [], tipp: [], laeuft: false,
      start() { this.ts = []; this.laeuft = true; const l = (t) => { if (!this.laeuft) return; this.ts.push(t); requestAnimationFrame(l); }; requestAnimationFrame(l); },
      stop() { this.laeuft = false; return { ts: this.ts.slice(), tipp: this.tipp.slice() }; } };
    window.__mess = m;
    window.addEventListener('keydown', (e) => {
      if (!m.laeuft) return;
      const t0 = e.timeStamp;
      requestAnimationFrame(() => requestAnimationFrame(() => m.tipp.push(performance.now() - t0)));
    }, true);
  });
  if (profil.bremse > 1) await cdp.send('Emulation.setCPUThrottlingRate', { rate: profil.bremse });
  await p.waitForTimeout(400);

  const zaehler = async () => (await cdp.send('Performance.getMetrics')).metrics.reduce((a, m) => { a[m.name] = m.value; return a; }, {});
  const strecke = async (handlung) => {
    await p.evaluate(() => window.__mess.start());
    const c0 = cpuBaum(pid); const m0 = await zaehler();
    await handlung();
    const m1 = await zaehler(); const c1 = cpuBaum(pid);
    const roh = await p.evaluate(() => window.__mess.stop());
    const d = m1.Timestamp - m0.Timestamp;
    return {
      ...bilder(roh.ts),
      stil: rund((m1.RecalcStyleDuration - m0.RecalcStyleDuration) * 1000),
      skript: rund((m1.ScriptDuration - m0.ScriptDuration) * 1000),
      layoutZahl: m1.LayoutCount - m0.LayoutCount,
      cpu: rund(((c1 - c0) / d) * 100),
      tipp: roh.tipp,
    };
  };

  const leer = await strecke(() => p.waitForTimeout(3000));
  await p.mouse.move(Math.round(profil.breite * 0.6), Math.round(profil.hoehe * 0.5));
  const scroll = await strecke(async () => {
    for (let r = 0; r < 2; r += 1) {
      for (let i = 0; i < 15; i += 1) { await p.mouse.wheel(0, -110); await p.waitForTimeout(16); }
      for (let i = 0; i < 15; i += 1) { await p.mouse.wheel(0, 110); await p.waitForTimeout(16); }
    }
  });
  await p.click('textarea').catch(() => {});
  await p.waitForTimeout(200);
  const tipp = await strecke(() => p.keyboard.type('Guten Morgen zusammen kurz', { delay: 55 }));
  const t = [...tipp.tipp].sort((a, b) => a - b);
  const med = t.length ? rund(t[t.length >> 1]) : 0;

  console.log(`  ${v.name.padEnd(30)} ${String(leer.fps).padStart(5)} ${String(leer.cpu).padStart(6)}`
    + `      ${String(scroll.fps).padStart(5)} ${String(scroll.lahm).padStart(5)} ${String(scroll.stil).padStart(6)} ${String(scroll.cpu).padStart(6)}`
    + `     ${String(med).padStart(6)} ${String(tipp.layoutZahl).padStart(7)}`);

  await ctx.close();
}

await browser.close();
await server.close();
await probe.stop();
console.log('');
