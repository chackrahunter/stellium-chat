/**
 * Prüft gegen eine frische Datenbank, was eine Kontolöschung wirklich
 * anfasst — und was bewusst stehen bleibt.
 *
 * Der Befund lautete: push_subscriptions blieb stehen (der Fremdschlüssel
 * trägt ON DELETE CASCADE, aber die users-Zeile wird nur geändert, nie
 * gelöscht — die Kaskade greift nie), und praesenz_tage stand nicht in der
 * Löschliste. Für die Push-Abos ist das ein Leck: sie zeigen auf das Gerät
 * einer Person, die es nicht mehr gibt. Für die Onlinezeiten ist es eine
 * bewusste Entscheidung (siehe Kommentar über deleteAccount() in
 * services/users.ts) — dieser Lauf prüft beides.
 *
 * Aufruf:  node scripts/konto-loeschen-pruefen.mjs
 */
import { db, initDb } from '../db/index.js';
import { deleteAccount } from '../services/users.js';

initDb();

let fehler = 0;
const pruef = (name: string, ist: unknown, soll: unknown) => {
  const ok = JSON.stringify(ist) === JSON.stringify(soll);
  if (!ok) fehler++;
  console.log(`  ${ok ? '\x1b[32m✓\x1b[0m' : '\x1b[31m✗\x1b[0m'} ${name}${ok ? '' : `  ${JSON.stringify(ist)} statt ${JSON.stringify(soll)}`}`);
};

db.run(`INSERT INTO users (id, handle, display_name, password_hash, created_at)
        VALUES ('probeU', 'probeU', 'Probe', 'x', 0)`);
db.run(`INSERT INTO push_subscriptions (id, user_id, endpoint, p256dh, auth, created_at)
        VALUES ('probeP', 'probeU', 'https://push.example/geraet', 'p', 'a', 0)`);
db.run("INSERT INTO praesenz_tage (user_id, tag, sekunden) VALUES ('probeU', '2026-08-01', 3600)");

deleteAccount('probeU');

pruef(
  'push_subscriptions der Person ist weg (kein totes Gerät bekommt noch Zustellungen)',
  db.all('SELECT 1 FROM push_subscriptions WHERE user_id = ?', 'probeU'), [],
);
pruef(
  'praesenz_tage bleibt bewusst stehen (betrieblich gebraucht, schon anonymisiert)',
  db.get<{ sekunden: number }>('SELECT sekunden FROM praesenz_tage WHERE user_id = ?', 'probeU')?.sekunden, 3600,
);
pruef(
  'das Konto selbst ist anonymisiert — praesenz_tage zeigt darüber denselben Namen',
  db.get<{ n: string }>('SELECT display_name AS n FROM users WHERE id = ?', 'probeU')?.n, 'Ehemaliges Mitglied',
);

console.log(fehler ? `\n\x1b[31m${fehler} fehlgeschlagen\x1b[0m\n` : '\n\x1b[32mKontolöschung trifft Geräte, lässt Betriebszahlen anonymisiert stehen.\x1b[0m\n');
process.exit(fehler ? 1 : 0);
