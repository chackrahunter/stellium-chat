/**
 * Zählt das Besuchersignal richtig — gegen eine WEGWERFBARE Datenbank.
 * Und: landet nichts auf der Platte, was einen Besucher wiedererkennbar macht?
 *
 * Aufruf:  node scripts/webbesuch-pruefen.mjs
 */
import assert from 'node:assert/strict';
import { db, initDb } from '../db/index.js';
import { aufnehmen, zahlen, pfadSaeubern, geraetVon } from '../services/webbesuch.js';

initDb();

const IPHONE = 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) Mobile/15E148 Safari/604.1';
const MAC = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 Safari/605.1.15';

assert.equal(pfadSaeubern('/De/Leitwert/?x=1#a'), '/de/leitwert/');
assert.equal(pfadSaeubern('https://fremd/'), null);
assert.equal(pfadSaeubern('/<script>'), null);
assert.equal(geraetVon(IPHONE), 'mobil');
assert.equal(geraetVon(MAC), 'desktop');
assert.equal(geraetVon('Mozilla/5.0 (Linux; Android 14; SM-X710) Safari'), 'tablet');

// Eine Person: zwei Seiten und ein Lebenszeichen. Eine zweite auf dem Mac.
aufnehmen({ adresse: '203.0.113.7', browser: IPHONE, land: 'DE', pfad: '/de/', sprache: 'de', aufruf: true });
aufnehmen({ adresse: '203.0.113.7', browser: IPHONE, land: 'DE', pfad: '/leitwert/', sprache: 'de', aufruf: true });
aufnehmen({ adresse: '203.0.113.7', browser: IPHONE, land: 'DE', pfad: '/leitwert/', sprache: 'de', aufruf: false });
aufnehmen({ adresse: '198.51.100.2', browser: MAC, land: 'US', pfad: '/', sprache: 'en', aufruf: true });
// Maschinen und Unsinn zählen nicht.
aufnehmen({ adresse: '192.0.2.1', browser: 'Googlebot/2.1', land: 'US', pfad: '/', sprache: 'en', aufruf: true });
aufnehmen({ adresse: '192.0.2.2', browser: MAC, land: 'US', pfad: 'kaputt', sprache: 'en', aufruf: true });

const z = zahlen();
assert.equal(z.jetzt, 2);
assert.deepEqual(z.heute, { besucher: 2, aufrufe: 3 });
assert.deepEqual(z.gesamt, z.heute);
assert.deepEqual(Object.fromEntries(z.laender), { DE: 1, US: 1 });
assert.deepEqual(Object.fromEntries(z.geraete), { mobil: 1, desktop: 1 });
assert.deepEqual(Object.fromEntries(z.seiten), { '/de/': 1, '/leitwert/': 1, '/': 1 });

// Takt: mehr als 30 Signale je Minute und Adresse werden verworfen.
for (let i = 0; i < 40; i++) {
  aufnehmen({ adresse: '198.51.100.9', browser: MAC, land: 'FR', pfad: '/flut/', sprache: 'fr', aufruf: true });
}
assert.equal(Object.fromEntries(zahlen().seiten)['/flut/'], 30);

// Auf der Platte nur Summen: keine Adresse, kein Browsername.
const roh = JSON.stringify(db.all('SELECT * FROM webbesuch_tage'));
assert.ok(!roh.includes('203.0.113') && !roh.includes('Mozilla'), roh);

console.log('webbesuch: alles richtig');
