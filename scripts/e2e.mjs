/**
 * End-to-End-Test der Oberfläche mit einem echten Chromium.
 *
 *   node scripts/e2e.mjs            alle Tests
 *   node scripts/e2e.mjs --sichtbar Browserfenster mitlaufen lassen
 *
 * Voraussetzung: Server auf 8787 und Vite auf 5173 laufen.
 * Fehlschläge landen als Screenshot in scripts/screenshots/.
 */
import { chromium } from 'playwright';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const shots = path.join(root, 'scripts/screenshots');
fs.mkdirSync(shots, { recursive: true });

const SERVER = 'http://localhost:8787';
const APP = 'http://localhost:5173';
const sichtbar = process.argv.includes('--sichtbar');

const ergebnisse = [];
let seite;

function log(zeile) { process.stdout.write(zeile + '\n'); }

/** Alles Offene schließen, sonst blockiert ein Overlay alle folgenden Klicks. */
async function aufraeumen() {
  if (!seite) return;
  for (let i = 0; i < 4; i++) {
    const offen = await seite.locator('.scrim, .lightbox').count().catch(() => 0);
    if (!offen) break;
    await seite.keyboard.press('Escape').catch(() => {});
    await seite.waitForTimeout(220);
  }
  // Rest der Ausblend-Animation abwarten
  await seite.waitForTimeout(120);
}

async function pruefe(name, fn) {
  const start = Date.now();
  try {
    await aufraeumen();
    const notiz = await fn();
    const ms = Date.now() - start;
    ergebnisse.push({ name, ok: true, ms, notiz });
    log(`  ✓ ${name}${notiz ? ` — ${notiz}` : ''}  (${ms}ms)`);
  } catch (err) {
    const ms = Date.now() - start;
    ergebnisse.push({ name, ok: false, ms, fehler: err.message });
    log(`  ✗ ${name} — ${err.message}  (${ms}ms)`);
    const datei = path.join(shots, `fehler-${name.replace(/[^a-z0-9]+/gi, '-').toLowerCase()}.png`);
    try { await seite.screenshot({ path: datei }); log(`      Screenshot: ${datei}`); } catch {}
    // Aufräumen, damit ein Fehler nicht alle folgenden Prüfungen mitreißt
    await aufraeumen().catch(() => {});
  }
}

function muss(bedingung, nachricht) {
  if (!bedingung) throw new Error(nachricht);
}

/** Wartet, bis der Ausdruck wahr wird — sonst Fehler. */
async function warteAuf(fn, nachricht, timeout = 15000) {
  const ende = Date.now() + timeout;
  while (Date.now() < ende) {
    if (await fn()) return true;
    await seite.waitForTimeout(250);
  }
  throw new Error(nachricht);
}

/** Text ins Eingabefeld schreiben, als würde jemand tippen. */
async function tippe(text, { leeren = true } = {}) {
  const feld = seite.locator('.composer__input');
  await feld.click();
  if (leeren) await feld.fill('');
  await feld.type(text, { delay: 8 });
}

async function main() {
  // Vorbedingungen prüfen, sonst laufen wir gegen Wände
  const health = await fetch(`${SERVER}/api/health`).then((r) => r.json()).catch(() => null);
  muss(health?.ok, `Server auf ${SERVER} antwortet nicht`);
  log(`\nServer bereit — KI: ${health.ai.provider}, Übersetzung ${health.ai.translation ? 'an' : 'aus'}, Assistent ${health.ai.assistant ? 'an' : 'aus'}\n`);

  const browser = await chromium.launch({ headless: !sichtbar });
  const kontext = await browser.newContext({
    viewport: { width: 1440, height: 900 },
    locale: 'de-DE',
    permissions: ['microphone'],
  });
  seite = await kontext.newPage();

  const konsolenfehler = [];
  seite.on('console', (m) => { if (m.type() === 'error') konsolenfehler.push(m.text()); });
  seite.on('pageerror', (e) => konsolenfehler.push(`pageerror: ${e.message}`));

  /* ── Anmeldung ────────────────────────────────────────────── */
  log('Anmeldung');

  await pruefe('Login-Seite lädt', async () => {
    await seite.goto(APP, { waitUntil: 'domcontentloaded' });
    await seite.waitForSelector('.auth__card', { timeout: 20000 });
    return 'Formular sichtbar';
  });

  await pruefe('Anmelden mit Demo-Konto', async () => {
    await seite.fill('.auth__card input[autocomplete="username"]', 'don');
    await seite.fill('.auth__card input[type="password"]', 'stellium2024');
    await seite.click('.auth__card button[type="submit"]');
    await seite.waitForSelector('.app', { timeout: 20000 });
    await seite.waitForSelector('.msg', { timeout: 20000 });
    return 'Chat geladen';
  });

  /* ── Grundgerüst ──────────────────────────────────────────── */
  log('\nLayout');

  await pruefe('Composer ist vollständig sichtbar', async () => {
    const mass = await seite.evaluate(() => {
      const c = document.querySelector('.composer');
      const r = c.getBoundingClientRect();
      return { unten: r.bottom, fenster: window.innerHeight, hoehe: r.height };
    });
    muss(mass.unten <= mass.fenster + 1,
      `Composer ragt ${Math.round(mass.unten - mass.fenster)}px unter den Fensterrand`);
    muss(mass.hoehe > 40, 'Composer ist zusammengefallen');
    return `Unterkante bei ${Math.round(mass.unten)} von ${mass.fenster}px`;
  });

  await pruefe('Nachrichtenliste scrollt', async () => {
    const vorher = await seite.evaluate(() => document.querySelector('.stream').scrollTop);
    await seite.evaluate(() => { document.querySelector('.stream').scrollTop = 0; });
    await seite.waitForTimeout(200);
    const oben = await seite.evaluate(() => document.querySelector('.stream').scrollTop);
    await seite.evaluate(() => { const s = document.querySelector('.stream'); s.scrollTop = s.scrollHeight; });
    await seite.waitForTimeout(200);
    const unten = await seite.evaluate(() => document.querySelector('.stream').scrollTop);
    muss(unten > oben, 'Scrollposition ändert sich nicht');
    return `von ${oben} bis ${Math.round(unten)}`;
  });

  /* ── Nachrichten ──────────────────────────────────────────── */
  log('\nNachrichten');

  const marke = `Test ${Date.now().toString(36).slice(-5)}`;

  await pruefe('Nachricht senden', async () => {
    await tippe(`${marke} — automatischer Durchlauf`);
    await seite.press('.composer__input', 'Enter');
    await warteAuf(async () => (await seite.locator('.msg', { hasText: marke }).count()) > 0,
      'Gesendete Nachricht erscheint nicht');
    return 'im Verlauf angekommen';
  });

  await pruefe('Automatisches Nachscrollen', async () => {
    const unten = await seite.evaluate(() => {
      const s = document.querySelector('.stream');
      return s.scrollHeight - s.scrollTop - s.clientHeight;
    });
    muss(unten < 150, `${Math.round(unten)}px vom Ende entfernt — es wurde nicht nachgescrollt`);
    return `${Math.round(unten)}px vom Ende`;
  });

  await pruefe('Reaktion setzen', async () => {
    const nachricht = seite.locator('.msg', { hasText: marke }).last();
    await nachricht.hover();
    await nachricht.locator('.msg__actions button').first().click();
    await warteAuf(async () => (await nachricht.locator('.reaction').count()) > 0,
      'Reaktion erscheint nicht');
    return await nachricht.locator('.reaction').first().innerText();
  });

  await pruefe('Erwähnungsliste erscheint', async () => {
    await tippe('Hallo @');
    await warteAuf(async () => (await seite.locator('.composer .result').count()) > 0,
      'Keine Vorschlagsliste beim @-Zeichen');
    const anzahl = await seite.locator('.composer .result').count();
    // Sichtbarkeit wirklich prüfen, nicht nur Existenz im DOM
    const sichtbarkeit = await seite.evaluate(() => {
      const el = document.querySelector('.composer .result');
      const r = el.getBoundingClientRect();
      return { oben: r.top, hoehe: r.height, imBild: r.top >= 0 && r.bottom <= window.innerHeight };
    });
    muss(sichtbarkeit.imBild, 'Liste liegt außerhalb des sichtbaren Bereichs (abgeschnitten)');
    return `${anzahl} Personen, sichtbar`;
  });

  await pruefe('Erwähnung übernehmen', async () => {
    await seite.locator('.composer .result').first().click();
    const wert = await seite.inputValue('.composer__input');
    muss(/@\w+\s$/.test(wert), `Feld enthält "${wert}" — erwartet wurde ein eingesetzter Handle`);
    return wert.trim();
  });

  /* ── KI ───────────────────────────────────────────────────── */
  log('\nKI-Funktionen');

  const kiAn = health.ai.assistant;

  await pruefe('Antwortvorschläge holen', async () => {
    if (!kiAn) return 'übersprungen (kein Groq-Schlüssel)';
    await seite.fill('.composer__input', 'noch etwas text');   // absichtlich NICHT leer
    await seite.click('button[title="Antwortvorschläge holen"]');
    await warteAuf(async () => (await seite.locator('.smart-reply').count()) > 0,
      'Keine Vorschläge sichtbar (früherer Fehler: wurden bei gefülltem Feld versteckt)', 30000);
    const texte = await seite.locator('.smart-reply').allInnerTexts();
    return `${texte.length}: ${texte.map((t) => t.split('\n')[0]).join(' | ').slice(0, 80)}`;
  });

  await pruefe('Vorschlag übernehmen', async () => {
    if (!kiAn) return 'übersprungen';
    await seite.locator('.smart-reply').first().click();
    await warteAuf(async () => (await seite.inputValue('.composer__input')).length > 3,
      'Text wurde nicht übernommen', 5000);
    const wert = await seite.inputValue('.composer__input');
    await warteAuf(async () => (await seite.locator('.smart-reply').count()) === 0,
      'Vorschläge bleiben nach der Auswahl stehen', 5000);
    return `"${wert.slice(0, 45)}"`;
  });

  await pruefe('Umformulieren-Menü vollständig sichtbar', async () => {
    if (!kiAn) return 'übersprungen';
    await tippe('hallo wie gehts euch allen so');
    await seite.click('button[title="Text mit KI überarbeiten"]');
    await warteAuf(async () => (await seite.locator('.composer button', { hasText: 'Stichpunkte' }).count()) > 0,
      'Menü öffnet nicht');
    const eintraege = ['Korrigieren', 'Förmlicher', 'Freundlicher', 'Kürzen', 'Stichpunkte'];
    for (const e of eintraege) {
      const box = await seite.locator('.composer button', { hasText: e }).first().boundingBox();
      muss(box, `Eintrag "${e}" fehlt`);
      muss(box.y >= 0, `Eintrag "${e}" ist oben abgeschnitten (y=${Math.round(box.y)})`);
    }
    return `${eintraege.length} Einträge, keiner abgeschnitten`;
  });

  await pruefe('Umformulieren wirkt', async () => {
    if (!kiAn) return 'übersprungen';
    const vorher = await seite.inputValue('.composer__input');
    await seite.locator('.composer button', { hasText: 'Förmlicher' }).first().click();
    await warteAuf(async () => (await seite.inputValue('.composer__input')) !== vorher,
      'Text bleibt unverändert', 40000);
    return `"${(await seite.inputValue('.composer__input')).slice(0, 55)}"`;
  });

  /* ── Übersetzung ──────────────────────────────────────────── */
  log('\nÜbersetzung');

  await pruefe('Fremdsprachige Nachricht wird übersetzt', async () => {
    if (!health.ai.translation) return 'übersprungen (Demo-Provider)';
    // Als sarah (Englisch) etwas schreiben, das don (Deutsch) übersetzt sehen muss
    const antwort = await fetch(`${SERVER}/api/auth/login`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ login: 'sarah', password: 'stellium2024' }),
    }).then((r) => r.json());

    const kanal = await seite.evaluate(() => {
      const el = document.querySelector('.chan[aria-current="true"] .chan__name');
      return el?.textContent?.trim();
    });

    const satz = `Quick check ${marke}: could you review the deployment before Friday?`;
    await sendeAlsAnderer(antwort.token, kanal, satz);

    await warteAuf(async () => (await seite.locator('.msg', { hasText: satz.slice(0, 20) }).count()) > 0,
      'Nachricht von sarah kommt nicht an', 20000);

    await warteAuf(async () => {
      const n = seite.locator('.msg', { hasText: satz.slice(0, 20) }).last();
      return (await n.locator('.translated__meta').count()) > 0;
    }, 'Keine Übersetzung nachgeliefert', 40000);

    const nachricht = seite.locator('.msg', { hasText: satz.slice(0, 20) }).last();
    const angezeigt = await nachricht.locator('.msg__body .md').first().innerText();
    muss(!angezeigt.includes('could you review'),
      `Es wird noch das englische Original gezeigt: "${angezeigt.slice(0, 60)}"`);
    return `"${angezeigt.slice(0, 70)}"`;
  });

  await pruefe('Original einblendbar', async () => {
    if (!health.ai.translation) return 'übersprungen';
    const nachricht = seite.locator('.msg .translated__meta').last();
    await nachricht.click();
    await warteAuf(async () => (await seite.locator('.translated__original').count()) > 0,
      'Original wird nicht eingeblendet');
    return 'Umschalter funktioniert';
  });

  /* ── Umfragen ─────────────────────────────────────────────── */
  log('\nUmfragen');

  await pruefe('Umfrage anlegen', async () => {
    await seite.click('button[title="Umfrage starten"]');
    await seite.waitForSelector('.panel', { timeout: 5000 });
    await seite.fill('.panel input', `Testfrage ${marke}?`);
    const felder = seite.locator('.panel .stack input');
    await felder.nth(0).fill('Antwort A');
    await felder.nth(1).fill('Antwort B');
    await seite.locator('.panel button', { hasText: 'Umfrage starten' }).click();
    await warteAuf(async () => (await seite.locator('.poll', { hasText: `Testfrage ${marke}` }).count()) > 0,
      'Umfrage erscheint nicht im Verlauf', 15000);
    return 'im Kanal sichtbar';
  });

  await pruefe('Abstimmen', async () => {
    const umfrage = seite.locator('.poll', { hasText: `Testfrage ${marke}` }).last();
    await umfrage.locator('.poll-option').first().click();
    await warteAuf(async () => {
      const t = await umfrage.locator('.poll-option').first().innerText();
      return /\b1\b/.test(t);
    }, 'Stimme wird nicht gezählt', 10000);
    const fuss = await umfrage.locator('.poll__foot').innerText();
    return fuss.split('\n')[0];
  });

  /* ── Weitere Bedienelemente ───────────────────────────────── */
  log('\nDialoge und Panels');

  await pruefe('Schnellsuche (Cmd+K)', async () => {
    await seite.keyboard.press('Meta+k');
    const feld = seite.locator('.panel .omni-input').first();
    await feld.waitFor({ state: 'visible', timeout: 5000 });
    await feld.fill('engineering');
    await warteAuf(async () => (await seite.locator('.result').count()) > 0, 'Keine Treffer');
    await seite.keyboard.press('Escape');
    return 'öffnet, filtert, schließt';
  });

  await pruefe('Volltextsuche', async () => {
    await seite.keyboard.press('Meta+f');
    await seite.waitForSelector('.panel--wide', { timeout: 5000 });
    // Genau das Feld im Suchfenster — während der Ein-/Ausblendung kann es
    // kurzzeitig zwei .omni-input im Dokument geben.
    const feld = seite.locator('.panel--wide .omni-input');
    await feld.waitFor({ state: 'visible', timeout: 5000 });
    await feld.click();
    await feld.fill('latency');
    await warteAuf(async () => (await seite.locator('.panel--wide .result').count()) > 0,
      'Kein Suchtreffer für "latency"', 15000);
    const treffer = await seite.locator('.panel--wide .result').count();
    await seite.keyboard.press('Escape');
    return `${treffer} Treffer`;
  });

  await pruefe('Profilkarte', async () => {
    await seite.locator('.msg__author').first().click();
    await seite.waitForSelector('.profile', { timeout: 5000 });
    const name = await seite.locator('.profile h2').innerText();
    await seite.keyboard.press('Escape');
    return name;
  });

  await pruefe('Weiterleiten-Dialog', async () => {
    const nachricht = seite.locator('.msg', { hasText: marke }).first();
    await nachricht.hover();
    await nachricht.locator('button[title="Mehr"]').click();
    await seite.locator('button', { hasText: 'Weiterleiten' }).first().click();
    await seite.waitForSelector('.panel', { timeout: 5000 });
    const ziele = await seite.locator('.panel .result').count();
    await seite.keyboard.press('Escape');
    return `${ziele} Ziele zur Auswahl`;
  });

  await pruefe('Erinnerung anlegen', async () => {
    const nachricht = seite.locator('.msg', { hasText: marke }).first();
    await nachricht.hover();
    await nachricht.locator('button[title="Mehr"]').click();
    await seite.locator('button', { hasText: 'Später erinnern' }).first().click();
    await seite.waitForSelector('.panel', { timeout: 5000 });
    await seite.locator('.panel button', { hasText: 'In 20 Minuten' }).click();
    await warteAuf(async () => (await seite.locator('.toast').count()) > 0, 'Keine Bestätigung');
    return await seite.locator('.toast__title').first().innerText();
  });

  await pruefe('Erinnerungsliste', async () => {
    await seite.locator('.rail button[title="Erinnerungen"]').click();
    await seite.waitForSelector('.panel', { timeout: 5000 });
    const anzahl = await seite.locator('.panel .row').count();
    muss(anzahl > 0, 'Die eben angelegte Erinnerung fehlt in der Liste');
    await seite.keyboard.press('Escape');
    return `${anzahl} Eintrag/Einträge`;
  });

  await pruefe('Thread öffnen und antworten', async () => {
    const nachricht = seite.locator('.msg', { hasText: marke }).first();
    await nachricht.hover();
    await nachricht.locator('button[title="Im Thread antworten"]').click();
    await seite.waitForSelector('.thread', { timeout: 5000 });
    await seite.locator('.thread .composer__input').fill('Antwort im Thread');
    await seite.locator('.thread .composer__input').press('Enter');
    await warteAuf(async () => (await seite.locator('.thread .msg').count()) >= 2,
      'Thread-Antwort erscheint nicht', 10000);
    const anzahl = await seite.locator('.thread .msg').count();
    await seite.keyboard.press('Escape');
    return `${anzahl} Nachrichten im Thread`;
  });

  /* ── Einstellungen ────────────────────────────────────────── */
  log('\nEinstellungen');

  await pruefe('Einstellungen öffnen', async () => {
    await seite.locator('.rail button[title="Einstellungen"]').click();
    await seite.waitForSelector('.panel--wide .tab', { timeout: 8000 });
    const tabs = await seite.locator('.panel--wide .tab').allInnerTexts();
    muss(tabs.length >= 5, `Nur ${tabs.length} Reiter gefunden`);
    return tabs.map((t) => t.trim()).join(', ');
  });

  await pruefe('Modellauswahl zeigt echte Groq-Modelle', async () => {
    await seite.locator('.rail button[title="Einstellungen"]').click();
    await seite.waitForSelector('.panel--wide .tab', { timeout: 8000 });
    await seite.locator('.panel--wide .tab', { hasText: 'KI-Modell' }).click();
    if (!kiAn) { await seite.keyboard.press('Escape'); return 'übersprungen'; }
    await warteAuf(async () => (await seite.locator('.panel--wide .row').count()) > 0,
      'Keine Modelle gelistet', 15000);
    const modelle = await seite.locator('.panel--wide .row__title').allInnerTexts();
    muss(modelle.some((m) => /gpt-oss|llama|qwen/i.test(m)),
      `Liste sieht falsch aus: ${modelle.slice(0, 3).join(', ')}`);
    return `${modelle.length} Modelle, u.a. ${modelle[0]}`;
  });

  await pruefe('Sprache umstellen', async () => {
    await seite.locator('.rail button[title="Einstellungen"]').click();
    await seite.waitForSelector('.panel--wide .tab', { timeout: 8000 });
    await seite.locator('.panel--wide .tab', { hasText: 'Sprache' }).click();
    await seite.selectOption('.panel--wide select', 'en');
    await warteAuf(async () => {
      const t = await seite.locator('.sidebar__sub').innerText();
      return /English/i.test(t);
    }, 'Sprache in der Seitenleiste ändert sich nicht', 10000);
    await seite.selectOption('.panel--wide select', 'de');
    await seite.waitForTimeout(500);
    await seite.keyboard.press('Escape');
    return 'de -> en -> de';
  });

  await pruefe('Helles Thema', async () => {
    await seite.locator('.rail button[title="Einstellungen"]').click();
    await seite.waitForSelector('.panel--wide .tab', { timeout: 8000 });
    await seite.locator('.panel--wide .tab', { hasText: 'Darstellung' }).click();
    await seite.locator('.panel--wide button', { hasText: 'Hell' }).click();
    await warteAuf(async () => (await seite.evaluate(() => document.documentElement.dataset.theme)) === 'light',
      'Thema wechselt nicht');
    await seite.screenshot({ path: path.join(shots, 'thema-hell.png') });
    await seite.locator('.panel--wide button', { hasText: 'Dunkel' }).click();
    await seite.waitForTimeout(300);
    await seite.keyboard.press('Escape');
    return 'hell und dunkel schalten';
  });

  /* ── Abschluss ────────────────────────────────────────────── */
  await seite.screenshot({ path: path.join(shots, 'uebersicht.png'), fullPage: false });

  await pruefe('Keine Fehler in der Browser-Konsole', async () => {
    // React-Warnungen aus dem Entwicklungsmodus sind kein Defekt
    const echte = konsolenfehler.filter((f) =>
      !/Download the React DevTools|Warning:.*deprecated|favicon/i.test(f));
    muss(echte.length === 0, `${echte.length}: ${echte.slice(0, 2).join(' | ').slice(0, 200)}`);
    return 'sauber';
  });

  await browser.close();

  /* ── Bericht ──────────────────────────────────────────────── */
  const ok = ergebnisse.filter((r) => r.ok).length;
  const fehler = ergebnisse.filter((r) => !r.ok);
  log(`\n${'─'.repeat(62)}`);
  log(`${ok} von ${ergebnisse.length} Prüfungen bestanden`);
  if (fehler.length) {
    log('\nFehlgeschlagen:');
    for (const f of fehler) log(`  ✗ ${f.name}: ${f.fehler}`);
  }
  log(`\nScreenshots: ${shots}`);
  process.exit(fehler.length ? 1 : 0);
}

/** Hilfsfunktion: als anderer Nutzer eine Nachricht schicken. */
async function sendeAlsAnderer(token, kanalName, text) {
  const ws = new WebSocket('ws://localhost:8787/ws');
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('WS-Timeout')), 10000);
    ws.onopen = () => ws.send(JSON.stringify({ t: 'auth', token, protocol: 1 }));
    ws.onmessage = (e) => {
      const ev = JSON.parse(e.data);
      if (ev.t === 'ready') {
        const kanal = ev.channels.find((c) => c.name === kanalName) ?? ev.channels[0];
        ws.send(JSON.stringify({ t: 'message:send', clientId: 'e2e', channelId: kanal.id, text }));
        clearTimeout(timer);
        setTimeout(() => { ws.close(); resolve(); }, 600);
      }
    };
    ws.onerror = () => { clearTimeout(timer); reject(new Error('WS-Fehler')); };
  });
}

main().catch((err) => {
  log(`\nAbbruch: ${err.message}`);
  process.exit(1);
});
