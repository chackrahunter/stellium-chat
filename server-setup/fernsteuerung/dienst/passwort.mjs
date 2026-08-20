#!/usr/bin/env node
/**
 * ID und Passwort für die Fernsteuerung anzeigen oder neu setzen.
 *
 * Ohne das hier wäre die Fernsteuerung unbenutzbar gewesen: der Dienst würfelt
 * beim ersten Start ein Passwort, speichert daraus nur den abgeleiteten
 * Schlüssel — und zeigte den Klartext nirgends an. Er war damit im selben
 * Augenblick verloren, in dem er entstand.
 *
 * Angezeigt wird das Passwort deshalb **nur hier und nur einmal**, beim
 * Setzen. Danach lässt es sich nicht mehr hervorholen, sondern nur neu
 * vergeben — aus dem gespeicherten Schlüssel zurückzurechnen hieße, scrypt
 * umzukehren.
 *
 *     stellium-fern-passwort            zeigt die ID
 *     stellium-fern-passwort --neu      würfelt ein neues Passwort
 *     stellium-fern-passwort --setzen   setzt ein selbst gewähltes
 */
import fs from 'node:fs';
import path from 'node:path';
import { execSync } from 'node:child_process';
import { kennungLaden, kennungNeu } from './anmeldung.mjs';

const ORDNER = process.env.FERN_ORDNER ?? '/var/lib/stellium/fern';
const F = { grau: '\x1b[90m', gruen: '\x1b[32m', gelb: '\x1b[33m', fett: '\x1b[1m', aus: '\x1b[0m' };

const args = process.argv.slice(2);
const neu = args.includes('--neu');
const setzenIdx = args.indexOf('--setzen');
const eigenes = setzenIdx >= 0 ? args[setzenIdx + 1] : null;

if (setzenIdx >= 0 && (!eigenes || eigenes.length < 8)) {
  console.error('\n  Ein selbst gewähltes Passwort braucht mindestens 8 Zeichen.\n');
  process.exit(1);
}

function dienstNeuStarten() {
  /* Der Dienst hält die Kennung im Speicher — ohne Neustart gälte weiter das
     alte Passwort, und das wäre die schlimmste Sorte Fehler: einer, bei dem
     alles richtig aussieht. */
  try {
    execSync('systemctl is-active --quiet stellium-fern.service', { stdio: 'ignore' });
    execSync('systemctl restart stellium-fern.service', { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

if (neu || eigenes) {
  const k = kennungNeu(ORDNER, eigenes ?? undefined);
  const lief = dienstNeuStarten();
  console.log(`
  ${F.fett}Fernsteuerung${F.aus}

    ID         ${F.fett}${k.id.replace(/(\d{3})(?=\d)/g, '$1 ')}${F.aus}
    Passwort   ${F.fett}${F.gruen}${k.klartext}${F.aus}

  ${F.gelb}Das Passwort steht nur jetzt hier.${F.aus} ${F.grau}Danach ist es nicht mehr
  hervorzuholen — gespeichert wird nur ein daraus abgeleiteter Schlüssel.${F.aus}
${lief ? '' : `\n  ${F.gelb}!${F.aus} Der Dienst lief nicht — beim nächsten Start gilt das neue Passwort.\n`}`);
} else {
  const datei = path.join(ORDNER, 'kennung.json');
  if (!fs.existsSync(datei)) {
    console.log(`
  Noch keine Kennung. Eine anlegen:

      sudo stellium-fern-passwort --neu
`);
    process.exit(0);
  }
  const k = kennungLaden(ORDNER);
  console.log(`
  ${F.fett}Fernsteuerung${F.aus}

    ID         ${F.fett}${k.id.replace(/(\d{3})(?=\d)/g, '$1 ')}${F.aus}
    Passwort   ${F.grau}nicht anzeigbar — nur neu vergebbar${F.aus}
    geändert   ${F.grau}${k.geaendert ?? 'unbekannt'}${F.aus}

  ${F.grau}Neues Passwort:  sudo stellium-fern-passwort --neu${F.aus}
`);
}
