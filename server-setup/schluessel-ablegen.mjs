#!/usr/bin/env node
/**
 * Legt einen Schlüssel verschlüsselt im Tresor ab.
 *
 *   printf '%s' "gsk_…" | node schluessel-ablegen.mjs groq
 *
 * Bewusst gegen das gebaute dist/ statt über tsx: auf dem Pi soll dafür nichts
 * nachgeladen und nichts übersetzt werden müssen. Der Wert kommt über die
 * Standardeingabe, damit er nie in der Prozessliste auftaucht.
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const name = process.argv[2];
if (!name) { console.error('Welcher Schlüssel? z.B. groq'); process.exit(1); }

const hier = path.dirname(fileURLToPath(import.meta.url));
const { Vault } = await import(path.join(hier, '../packages/server/dist/secrets.js'));

const passwort = process.env.STELLIUM_MASTER_PASSPHRASE;
if (!passwort) { console.error('STELLIUM_MASTER_PASSPHRASE fehlt.'); process.exit(1); }

const datenOrdner = process.env.DATA_DIR
  ?? path.join(hier, '../packages/server/data');

let wert = '';
process.stdin.setEncoding('utf8');
for await (const stueck of process.stdin) wert += stueck;
wert = wert.trim();
if (!wert) { console.error('Leerer Wert.'); process.exit(1); }

const tresor = new Vault(path.join(datenOrdner, 'secrets.enc'));
const inhalt = tresor.exists() ? tresor.load(passwort) : {};
inhalt[name] = wert;
tresor.save(inhalt, passwort);

console.log(`"${name}" abgelegt (${wert.length} Zeichen).`);
