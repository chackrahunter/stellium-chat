import path from 'node:path';
import readline from 'node:readline';
import crypto from 'node:crypto';
import { Writable } from 'node:stream';
import {
  Vault, deleteKeychain, keychainAvailable, readKeychain,
  redact, resolvePassphrase, writeKeychain,
} from '../secrets.js';

/**
 * Verwaltung der verschlüsselten Schlüssel.
 *
 *   npm run secret -w @stellium/server -- setzen groq
 *   npm run secret -w @stellium/server -- liste
 *   npm run secret -w @stellium/server -- entfernen groq
 *   npm run secret -w @stellium/server -- passwort-neu
 */

const dataDir = path.resolve(process.cwd(), process.env.DATA_DIR ?? './data');
const vault = new Vault(path.join(dataDir, 'secrets.enc'));

/**
 * Eingabe ohne Anzeige auf dem Bildschirm.
 * Kommt die Eingabe aus einer Pipe (kein Terminal), wird sie direkt gelesen —
 * so lässt sich der Befehl auch in Skripten und Tests verwenden.
 */
function askHidden(frage: string): Promise<string> {
  if (!process.stdin.isTTY) {
    return new Promise((resolve) => {
      let puffer = '';
      process.stdin.setEncoding('utf8');
      process.stdin.on('data', (d) => { puffer += d; });
      process.stdin.on('end', () => resolve(puffer.split('\n')[0].trim()));
    });
  }
  return new Promise((resolve) => {
    const stumm = new Writable({
      write(chunk, _enc, cb) {
        // Nur die Frage durchlassen, die Eingabe selbst nicht spiegeln.
        if (!(stumm as any).muted) process.stdout.write(chunk);
        cb();
      },
    });
    const rl = readline.createInterface({ input: process.stdin, output: stumm, terminal: true });
    process.stdout.write(frage);
    (stumm as any).muted = true;
    rl.question('', (answer) => {
      (stumm as any).muted = false;
      process.stdout.write('\n');
      rl.close();
      resolve(answer);
    });
  });
}

function ask(frage: string): Promise<string> {
  if (!process.stdin.isTTY) return Promise.resolve('j');   // Vorgabe in Skripten
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve) => rl.question(frage, (a) => { rl.close(); resolve(a.trim()); }));
}

/** Passwort besorgen — vorhandenes benutzen oder ein neues einrichten. */
async function getPassphrase(zumSchreiben: boolean): Promise<string> {
  const vorhanden = resolvePassphrase();
  if (vorhanden) {
    console.log(`Masterpasswort: aus ${vorhanden.source === 'env' ? 'der Umgebungsvariable' : 'der Keychain'}.`);
    return vorhanden.passphrase;
  }

  if (!zumSchreiben) {
    throw new Error(
      'Kein Masterpasswort gefunden.\n'
      + '  Entweder STELLIUM_MASTER_PASSPHRASE setzen\n'
      + '  oder einmal "npm run secret -- setzen <name>" ausführen, das legt es in der Keychain an.',
    );
  }

  console.log('\nEs gibt noch kein Masterpasswort. Damit wird der Tresor verschlüsselt.\n');
  if (keychainAvailable()) {
    const auto = await ask('Soll ich ein starkes Passwort erzeugen und in die Keychain legen? [J/n] ');
    if (auto === '' || /^j/i.test(auto)) {
      // 32 zufällige Bytes — nichts, was jemand erraten oder tippen muss.
      const erzeugt = crypto.randomBytes(32).toString('base64url');
      writeKeychain(erzeugt);
      console.log('Passwort erzeugt und in der macOS-Keychain abgelegt.');
      console.log('Es hängt an deinem Benutzerkonto. Ohne deine Anmeldung kommt niemand daran.\n');
      return erzeugt;
    }
  }

  const eingabe = await askHidden('Masterpasswort (Eingabe bleibt unsichtbar): ');
  if (eingabe.length < 12) throw new Error('Das Passwort braucht mindestens 12 Zeichen.');
  const wiederholung = await askHidden('Zur Sicherheit noch einmal: ');
  if (eingabe !== wiederholung) throw new Error('Die beiden Eingaben stimmen nicht überein.');

  if (keychainAvailable()) {
    const merken = await ask('In der Keychain merken, damit der Server ohne Nachfrage startet? [J/n] ');
    if (merken === '' || /^j/i.test(merken)) writeKeychain(eingabe);
  } else {
    console.log('\nMerke dir das Passwort. Der Server braucht es als STELLIUM_MASTER_PASSPHRASE.');
  }
  return eingabe;
}

async function main(): Promise<void> {
  const [befehl, name] = process.argv.slice(2);

  switch (befehl) {
    case 'setzen': {
      if (!name) throw new Error('Welcher Schlüssel? z.B. "setzen groq"');
      const passphrase = await getPassphrase(true);
      const wert = await askHidden(`Wert für "${name}" (Eingabe bleibt unsichtbar): `);
      if (!wert.trim()) throw new Error('Leerer Wert.');

      const secrets = vault.exists() ? vault.load(passphrase) : {};
      secrets[name] = wert.trim();
      vault.save(secrets, passphrase);

      console.log(`\n"${name}" verschlüsselt abgelegt: ${redact(wert.trim())}`);
      console.log(`Datei: ${path.join(dataDir, 'secrets.enc')}`);
      console.log('\nJetzt kannst du den Schlüssel aus der .env löschen.');
      break;
    }

    case 'liste': {
      const passphrase = await getPassphrase(false);
      if (!vault.exists()) { console.log('Es gibt noch keinen Tresor.'); break; }
      const namen = vault.names(passphrase);
      console.log(namen.length ? `Im Tresor: ${namen.join(', ')}` : 'Der Tresor ist leer.');
      console.log('(Die Werte selbst gibt dieser Befehl bewusst nicht aus.)');
      break;
    }

    case 'entfernen': {
      if (!name) throw new Error('Welcher Schlüssel? z.B. "entfernen groq"');
      const passphrase = await getPassphrase(false);
      const secrets = vault.load(passphrase);
      if (!(name in secrets)) { console.log(`"${name}" ist nicht im Tresor.`); break; }
      delete secrets[name];
      vault.save(secrets, passphrase);
      console.log(`"${name}" entfernt.`);
      break;
    }

    case 'passwort-neu': {
      const altes = resolvePassphrase();
      if (!altes) throw new Error('Kein bisheriges Passwort gefunden.');
      const secrets = vault.load(altes.passphrase);

      const neues = crypto.randomBytes(32).toString('base64url');
      vault.save(secrets, neues);
      if (keychainAvailable()) writeKeychain(neues);
      console.log('Neues Masterpasswort erzeugt, Tresor neu verschlüsselt.');
      console.log(keychainAvailable()
        ? 'Es liegt in der Keychain.'
        : `Setze STELLIUM_MASTER_PASSPHRASE auf: ${neues}`);
      break;
    }

    case 'keychain-loeschen':
      deleteKeychain();
      console.log('Keychain-Eintrag entfernt. Ohne STELLIUM_MASTER_PASSPHRASE kommt der Server nicht mehr an den Tresor.');
      break;

    default:
      console.log(`Stellium — verschlüsselte Schlüsselablage

  setzen <name>        Schlüssel eingeben und verschlüsselt ablegen
  liste                Zeigt, welche Schlüssel im Tresor liegen (ohne Werte)
  entfernen <name>     Schlüssel löschen
  passwort-neu         Masterpasswort erneuern und Tresor neu verschlüsseln
  keychain-loeschen    Masterpasswort aus der Keychain entfernen

Beispiel:
  npm run secret -w @stellium/server -- setzen groq

Masterpasswort kommt aus STELLIUM_MASTER_PASSPHRASE oder der macOS-Keychain.
Aktuell: ${resolvePassphrase()?.source ?? 'nicht eingerichtet'}${keychainAvailable() && readKeychain() ? ' (Keychain-Eintrag vorhanden)' : ''}`);
  }
}

main()
  // Ohne das bleibt der Prozess an offenen stdin-Handles hängen.
  .then(() => process.exit(0))
  .catch((err) => {
    console.error(`\nFehler: ${(err as Error).message}`);
    process.exit(1);
  });
