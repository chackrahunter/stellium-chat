/**
 * Hält der Handschlag?
 *
 * Geprüft wird nicht nur, dass er mit dem richtigen Passwort funktioniert —
 * das ist der langweilige Teil. Wichtiger sind die Fälle, in denen er
 * **scheitern muss**:
 *
 *   - falsches Passwort
 *   - jemand gibt sich als der Pi aus, ohne das Passwort zu kennen
 *   - verfälschte Nachricht
 *   - derselbe Startwert zweimal (bei AES-GCM fällt dabei der Schlüssel)
 *
 * Eine Prüfung, die nur den guten Fall abdeckt, sagt über eine Anmeldung
 * genau nichts aus.
 *
 *     node scripts/fern-anmeldung-pruefen.mjs
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import {
  kennungNeu, hallo, grussBauen, antwortBauen, antwortPruefen, Schatulle,
} from '../server-setup/fernsteuerung/dienst/anmeldung.mjs';

const F = { rot: '\x1b[31m', gruen: '\x1b[32m', grau: '\x1b[90m', aus: '\x1b[0m' };
let fehler = 0;
const pruefe = (was, bedingung, zusatz = '') => {
  const ok = Boolean(bedingung);
  if (!ok) fehler++;
  console.log(`  ${ok ? F.gruen + '✓' : F.rot + '✗'}${F.aus} ${was}` +
              (zusatz ? `  ${F.grau}${zusatz}${F.aus}` : ''));
};

const ordner = fs.mkdtempSync(path.join(os.tmpdir(), 'fern-probe-'));
const kennung = kennungNeu(ordner);
const PASSWORT = kennung.klartext;

console.log(`\nID ${kennung.id}   Passwort ${PASSWORT}\n`);

/* ── 1. Der gute Fall ────────────────────────────────────────── */
console.log('Richtiges Passwort');
{
  const mac = hallo();
  const pi = grussBauen(kennung, mac.hinaus);
  pruefe('Pi baut einen Gruß', pi !== null);
  const antwort = antwortBauen(PASSWORT, pi.hinaus, mac.paar);
  pruefe('Mac nimmt den Pi an', antwort.ok, antwort.grund ?? '');
  const urteil = antwortPruefen(pi, antwort.hinaus);
  pruefe('Pi nimmt den Mac an', urteil.ok, urteil.grund ?? '');
  pruefe('beide haben denselben Schlüssel',
         antwort.schluessel && urteil.schluessel &&
         Buffer.compare(antwort.schluessel, urteil.schluessel) === 0);
}

/* ── 2. Falsches Passwort ────────────────────────────────────── */
console.log('\nFalsches Passwort');
{
  const mac = hallo();
  const pi = grussBauen(kennung, mac.hinaus);
  const antwort = antwortBauen(PASSWORT + 'x', pi.hinaus, mac.paar);
  pruefe('Mac bricht ab, BEVOR er etwas preisgibt', !antwort.ok, antwort.grund ?? '');
  pruefe('kein Beweis wurde gebaut', antwort.hinaus === undefined);
}

/* ── 3. Jemand gibt sich als der Pi aus ──────────────────────── */
console.log('\nFremder gibt sich als der Pi aus');
{
  const mac = hallo();
  /* Der Angreifer kennt die ID und das Salz (beides ist öffentlich), aber
     nicht das Passwort. Er würfelt sich einen Schlüssel. */
  const gefaelscht = { ...kennung, schluessel: crypto.randomBytes(32).toString('base64') };
  const pi = grussBauen(gefaelscht, mac.hinaus);
  const antwort = antwortBauen(PASSWORT, pi.hinaus, mac.paar);
  pruefe('Mac erkennt den Betrug', !antwort.ok, antwort.grund ?? '');
  pruefe('Mac hat nichts herausgegeben', antwort.hinaus === undefined);
}

/* ── 4. Beweis nachträglich verändert ────────────────────────── */
console.log('\nBeweis unterwegs verändert');
{
  const mac = hallo();
  const pi = grussBauen(kennung, mac.hinaus);
  const antwort = antwortBauen(PASSWORT, pi.hinaus, mac.paar);
  const verbogen = Buffer.from(antwort.hinaus.beweis, 'base64');
  verbogen[0] ^= 1;
  const urteil = antwortPruefen(pi, { beweis: verbogen.toString('base64') });
  pruefe('Pi weist ihn ab', !urteil.ok, urteil.grund ?? '');
  const leer = antwortPruefen(pi, {});
  pruefe('leerer Beweis wird abgewiesen', !leer.ok);
}

/* ── 5. Verschlüsselung ──────────────────────────────────────── */
console.log('\nVerschlüsselung');
{
  const schluessel = crypto.randomBytes(32);
  const piSeite  = new Schatulle(schluessel, 'pi');
  const macSeite = new Schatulle(schluessel, 'pi');   /* zum Entschlüsseln */
  const text = Buffer.from('Ein Bild wäre hier normalerweise viel größer.');
  const paket = piSeite.zu(7, text);
  const zurueck = macSeite.auf(paket);
  pruefe('hin und zurück', zurueck && Buffer.compare(zurueck.inhalt, text) === 0);
  pruefe('Art kommt mit', zurueck?.art === 7);

  const verbogen = Buffer.from(paket);
  verbogen[verbogen.length - 1] ^= 1;
  pruefe('verfälschtes Paket wird verworfen', macSeite.auf(verbogen) === null);

  const falscheArt = Buffer.from(paket);
  falscheArt[0] = 9;
  pruefe('vertauschte Art wird erkannt (sie geht in die Prüfsumme ein)',
         new Schatulle(schluessel, 'pi').auf(falscheArt) === null);
}

/* ── 6. Startwerte dürfen sich nie wiederholen ───────────────── */
console.log('\nStartwerte');
{
  const s = new Schatulle(crypto.randomBytes(32), 'pi');
  const gesehen = new Set();
  for (let i = 0; i < 5000; i++) gesehen.add(s.startwert().toString('hex'));
  pruefe('5000 Startwerte, alle verschieden', gesehen.size === 5000,
         `${gesehen.size} verschiedene`);

  const pi = new Schatulle(Buffer.alloc(32, 1), 'pi');
  const mac = new Schatulle(Buffer.alloc(32, 1), 'mac');
  pruefe('Hin- und Rückrichtung benutzen getrennte Startwerte',
         pi.startwert().toString('hex') !== mac.startwert().toString('hex'));
}

/* ── 7. Der gespeicherte Schlüssel ist nicht das Passwort ────── */
console.log('\nWas auf der Platte liegt');
{
  const roh = fs.readFileSync(path.join(ordner, 'kennung.json'), 'utf8');
  pruefe('Passwort steht NICHT in der Datei', !roh.includes(PASSWORT));
  const stat = fs.statSync(path.join(ordner, 'kennung.json'));
  pruefe('Datei nur für den Besitzer lesbar',
         (stat.mode & 0o077) === 0, `Rechte ${(stat.mode & 0o777).toString(8)}`);
}

fs.rmSync(ordner, { recursive: true, force: true });
console.log(fehler
  ? `\n${F.rot}${fehler} Prüfung(en) fehlgeschlagen.${F.aus}\n`
  : `\n${F.gruen}Alle Prüfungen bestanden.${F.aus}\n`);
process.exit(fehler ? 1 : 0);
