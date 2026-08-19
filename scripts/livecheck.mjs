import { webkit, devices } from 'playwright';
const b = await webkit.launch({ headless: true });
const ctx = await b.newContext({ ...devices['iPhone 15 Pro'], viewport: { width: 402, height: 874 }, locale: 'de-DE', deviceScaleFactor: 2 });
const p = await ctx.newPage();
await p.goto('https://stellium-chat.duckdns.org/', { waitUntil: 'networkidle', timeout: 45000 });
await p.waitForTimeout(2500);
const stand = await p.evaluate(() => ({
  ueberlauf: document.documentElement.scrollWidth - document.documentElement.clientWidth,
  manifest: !!document.querySelector('link[rel=manifest]'),
  appleTitel: document.querySelector('meta[name="apple-mobile-web-app-title"]')?.content ?? null,
  viewport: document.querySelector('meta[name=viewport]')?.content ?? '',
}));
console.log('  Überlauf:', stand.ueberlauf, 'px');
console.log('  Manifest verlinkt:', stand.manifest);
console.log('  Name auf dem Startbildschirm:', stand.appleTitel);
console.log('  viewport-fit dabei:', stand.viewport.includes('viewport-fit=cover'));
await p.screenshot({ path: 'schirmbilder/live-iphone.png' });
await b.close();
