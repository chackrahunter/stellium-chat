/**
 * Prüft gegen eine frische Datenbank: `createMessage()` weist eine Nachricht
 * mit zu vielen Platzhaltern für noch hochladende Anhänge ab, und ebenso
 * eine mit einem zu langen Dateinamen darin — ohne dass eine Nachricht in
 * realistischer Größe je davon betroffen wäre.
 *
 * DER BEFUND, DEN DIESER LAUF ABDECKT
 * `pendingAttachments.length` allein erfüllte in createMessage() (services/
 * messages.ts) die "Nachricht ist nicht leer"-Prüfung — Anzahl und
 * Namenslänge der einzelnen Einträge blieben ungeprüft. Bei einem
 * `maxPayload` von 4 MB je WebSocket-Nachricht (index.ts) reicht das für
 * zehntausende Platzhalter in einer einzigen Nachricht, alle unbegrenzt in
 * `ausstehendeAnhaenge` (ws/gateway.ts) und an jede Person im Kanal
 * gesendet — ein günstiger Weg, den Speicher eines Pi zu füllen.
 *
 * Aufruf:  node scripts/anhang-platzhalter-obergrenze-pruefen.mjs
 */
import { db, initDb } from '../db/index.js';
import * as messages from '../services/messages.js';

initDb();

let fehler = 0;
const pruef = (name: string, ist: unknown, soll: unknown) => {
  const ok = JSON.stringify(ist) === JSON.stringify(soll);
  if (!ok) fehler++;
  console.log(`  ${ok ? '\x1b[32m✓\x1b[0m' : '\x1b[31m✗\x1b[0m'} ${name}${ok ? '' : `  ${JSON.stringify(ist)} statt ${JSON.stringify(soll)}`}`);
};

db.run(`INSERT OR IGNORE INTO users (id, handle, display_name, password_hash, created_at)
        VALUES ('probe-obergrenze-alice', 'probe-obergrenze-alice', 'Alice', 'x', 0)`);
db.run(`INSERT OR IGNORE INTO channels (id, kind, name, created_by, created_at)
        VALUES ('probe-obergrenze-ch', 'public', 'probe', 'probe-obergrenze-alice', 0)`);
db.run(`INSERT OR IGNORE INTO channel_members (channel_id, user_id, joined_at)
        VALUES ('probe-obergrenze-ch', 'probe-obergrenze-alice', 0)`);

/** Wirft die abweisung() mit einer bestimmten Kennung — oder gibt zurück,
 *  welche Kennung sie stattdessen trug (bzw. `undefined`, wenn nichts flog). */
function kennungBeiWurf(f: () => void): string | undefined {
  try {
    f();
    return undefined;
  } catch (e) {
    return (e as { code?: string }).code;
  }
}

console.log('\nRealistische Größen gehen unverändert durch (Gegenprobe — keine Regression):');
const wenige = kennungBeiWurf(() => messages.createMessage({
  channelId: 'probe-obergrenze-ch', userId: 'probe-obergrenze-alice', text: '',
  pendingAttachments: [
    { tempId: 't1', name: 'urlaubsfoto.jpg', mime: 'image/jpeg' },
    { tempId: 't2', name: 'video-vom-grillabend.mp4', mime: 'video/mp4' },
    { tempId: 't3', name: 'präsentation.pdf', mime: 'application/pdf' },
  ],
}));
pruef('drei plausible Anhänge werden angenommen', wenige, undefined);

const genauAmRand = kennungBeiWurf(() => messages.createMessage({
  channelId: 'probe-obergrenze-ch', userId: 'probe-obergrenze-alice', text: '',
  pendingAttachments: Array.from({ length: 30 }, (_, i) => ({ tempId: `rand${i}`, name: `datei-${i}.jpg`, mime: 'image/jpeg' })),
}));
pruef('genau 30 Anhänge (die dokumentierte Obergrenze) werden noch angenommen', genauAmRand, undefined);

const normalerName = kennungBeiWurf(() => messages.createMessage({
  channelId: 'probe-obergrenze-ch', userId: 'probe-obergrenze-alice', text: '',
  pendingAttachments: [{ tempId: 't4', name: 'a'.repeat(255), mime: 'image/jpeg' }],
}));
pruef('ein Dateiname mit genau 255 Zeichen (Dateisystem-Obergrenze) wird noch angenommen', normalerName, undefined);

console.log('\nDer eigentliche Befund — unrealistische Größen werden abgewiesen:');
const zuViele = kennungBeiWurf(() => messages.createMessage({
  channelId: 'probe-obergrenze-ch', userId: 'probe-obergrenze-alice', text: '',
  pendingAttachments: Array.from({ length: 5000 }, (_, i) => ({ tempId: `t${i}`, name: `datei-${i}.jpg`, mime: 'image/jpeg' })),
}));
pruef('5000 Platzhalter in einer Nachricht werden abgewiesen', zuViele, 'fehler.anhangPlatzhalterObergrenze');

const zuLangerName = kennungBeiWurf(() => messages.createMessage({
  channelId: 'probe-obergrenze-ch', userId: 'probe-obergrenze-alice', text: '',
  pendingAttachments: [{ tempId: 't5', name: 'x'.repeat(10_000), mime: 'image/jpeg' }],
}));
pruef('ein 10.000 Zeichen langer Dateiname wird abgewiesen', zuLangerName, 'fehler.anhangNameZuLang');

console.log(fehler
  ? `\n\x1b[31m${fehler} fehlgeschlagen\x1b[0m\n`
  : '\n\x1b[32mAnzahl und Namenslänge von Anhang-Platzhaltern sind begrenzt — realistische Nachrichten bleiben unangetastet.\x1b[0m\n');
process.exit(fehler ? 1 : 0);
