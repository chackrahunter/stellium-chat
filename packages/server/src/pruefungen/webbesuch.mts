/**
 * Zählt das Besuchersignal von Leitwert richtig — gegen eine WEGWERFBARE
 * Datenbank. Und: landet nichts auf der Platte, was einen Besucher
 * wiedererkennbar macht?
 *
 * Aufruf:  node scripts/webbesuch-pruefen.mjs
 */
import assert from 'node:assert/strict';
import { db, initDb } from '../db/index.js';
import { aufnehmen, zahlen } from '../services/webbesuch.js';

initDb();

const IPHONE = 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) Mobile/15E148 Safari/604.1';
const MAC = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 Safari/605.1.15';

// Eine Person mit zwei offenen Seiten (Öffnen, Öffnen, Lebenszeichen). Eine zweite auf dem Mac.
aufnehmen({ adresse: '203.0.113.7', browser: IPHONE, pfad: '/leitwert/', seite: 'seite-aaaa1', aufruf: true });
aufnehmen({ adresse: '203.0.113.7', browser: IPHONE, pfad: '/leitwert/', seite: 'seite-aaaa2', aufruf: true });
aufnehmen({ adresse: '203.0.113.7', browser: IPHONE, pfad: '/leitwert/', seite: 'seite-aaaa1', aufruf: false });
aufnehmen({ adresse: '198.51.100.2', browser: MAC, pfad: '/leitwert/', seite: 'seite-bbbb1', aufruf: true });
// Andere Seiten, Maschinen und Unsinn zählen nicht.
aufnehmen({ adresse: '198.51.100.3', browser: MAC, pfad: '/de/', aufruf: true });
aufnehmen({ adresse: '192.0.2.1', browser: 'Googlebot/2.1', pfad: '/leitwert/', aufruf: true });
aufnehmen({ adresse: '192.0.2.2', browser: MAC, pfad: 42, aufruf: true });

const z = zahlen();
assert.equal(z.jetzt, 3, 'drei offene Seiten');
assert.deepEqual(z.heute, { besucher: 2, aufrufe: 3 }, 'aber zwei Personen');

// Schließen meldet sofort ab.
aufnehmen({ adresse: '203.0.113.7', browser: IPHONE, pfad: '/leitwert/', seite: 'seite-aaaa2', aufruf: false, weg: true });
assert.equal(zahlen().jetzt, 2);
assert.deepEqual(z.woche, z.heute);
assert.deepEqual(z.monat, z.heute);
assert.deepEqual(z.gesamt, z.heute);

// Takt: mehr als 120 Signale je Minute und Adresse werden verworfen.
for (let i = 0; i < 130; i++) {
  aufnehmen({ adresse: '198.51.100.9', browser: MAC, pfad: '/leitwert/', seite: 'seite-flut1', aufruf: true });
}
assert.equal(zahlen().heute.aufrufe, 3 + 120);

// Auf der Platte nur Summen: keine Adresse, kein Browsername.
const roh = JSON.stringify(db.all('SELECT * FROM webbesuch_tage'));
assert.ok(!roh.includes('203.0.113') && !roh.includes('Mozilla'), roh);

console.log('webbesuch: alles richtig');
