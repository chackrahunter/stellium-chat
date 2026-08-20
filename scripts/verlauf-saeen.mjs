/**
 * Einen Kanal mit Nachrichten füllen — über den echten Weg.
 *
 * Warum nicht einfach in den Zustand schreiben: `window.__stelliumStore` gibt
 * es nur im Entwicklungsmodus, und zwar mit Absicht. Messen will man aber den
 * FERTIGEN Bau — unter Vite läuft React in der Entwicklungsfassung und kostet
 * ein Vielfaches, sodass jede Zahl von dort etwas beschreibt, das kein
 * Benutzer je zu sehen bekommt.
 *
 * Also derselbe Weg, den auch die App nimmt: anmelden, Nachrichten über den
 * Draht schicken, warten bis der Server sie bestätigt hat. Das ist obendrein
 * ehrlicher — Übersetzung, Verschlüsselung und Verlaufsgrenzen laufen mit.
 */
import { WebSocket } from 'ws';

const TEXTE = [
  'Der Entwurf für die neue Preisliste liegt jetzt im Ordner — schaut ihn euch bitte bis Freitag an.',
  'Kurze Rückfrage zur Lieferung nächste Woche: bleibt der Termin am Dienstag?',
  'Ich habe die Zahlen aus dem Quartalsbericht noch einmal nachgerechnet. Zwei Positionen waren doppelt.',
  'Passt',
  'Habe mit dem Lieferanten telefoniert. Er kann früher, will dafür aber eine Zusage bis morgen Mittag.',
  'Danke dir!',
  'Der Raum ist gebucht, 14 Uhr. Beamer ist da, Kabel bringe ich mit.',
  'Ich bin ab Donnerstag im Urlaub — die Vertretung ist geregelt, meldet euch bei Anna.',
  'Sehr gut, dann machen wir das so.',
  'Kann jemand kurz drüberschauen? Beim letzten Absatz bin ich mir nicht sicher, ob das verständlich ist.',
];

/**
 * Füllt den ersten offenen Kanal mit `anzahl` Nachrichten.
 *
 * Gibt die Kennung des Kanals zurück — die Messung braucht sie, um ihn zu
 * öffnen.
 */
export async function verlaufSaeen(probe, anzahl = 60, protokoll = 1) {
  const ws = new WebSocket(`${probe.S.replace('http', 'ws')}/ws`);
  await new Promise((fertig, schief) => { ws.once('open', fertig); ws.once('error', schief); });

  let bereit = null;
  let letzterFehler = null;
  const gesendet = new Set();
  ws.on('message', (roh) => {
    try {
      const ev = JSON.parse(roh.toString());
      if (ev.t === 'ready') bereit = ev;
      if (ev.t === 'message:new') gesendet.add(ev.clientId ?? ev.message?.id);
      if (ev.t === 'error') letzterFehler = ev.message ?? ev.code;
    } catch { /* anderes Ereignis */ }
  });

  ws.send(JSON.stringify({ t: 'auth', token: probe.token, protocol: protokoll }));
  const frist = Date.now() + 15000;
  while (!bereit && Date.now() < frist) await new Promise((f) => setTimeout(f, 40));
  if (!bereit) { ws.close(); throw new Error('Der Draht wurde nicht angemeldet.'); }

  const kanal = (bereit.channels ?? []).find((c) => c.kind !== 'dm' && !c.archived) ?? bereit.channels?.[0];
  if (!kanal) { ws.close(); throw new Error('Kein Kanal zum Füllen gefunden.'); }

  ws.send(JSON.stringify({ t: 'channel:open', channelId: kanal.id, limit: 50 }));

  /* In kleinen Schüben statt alle auf einmal: der Server übersetzt jede
     Nachricht und würde sonst in eine Warteschlange laufen, die den Lauf
     unnötig lange aufhält. */
  const kennungen = [];
  for (let i = 0; i < anzahl; i += 1) {
    const clientId = `saat-${i}-${Math.random().toString(36).slice(2, 8)}`;
    kennungen.push(clientId);
    ws.send(JSON.stringify({
      t: 'message:send', clientId, channelId: kanal.id,
      text: TEXTE[i % TEXTE.length], sourceLang: 'de',
    }));
    if (i % 10 === 9) await new Promise((f) => setTimeout(f, 120));
  }

  const bis = Date.now() + 60000;
  while (gesendet.size < anzahl && Date.now() < bis) await new Promise((f) => setTimeout(f, 100));
  const angekommen = gesendet.size;
  ws.close();
  if (angekommen < anzahl * 0.9) {
    throw new Error(`Nur ${angekommen} von ${anzahl} Nachrichten kamen an.`
      + (letzterFehler ? ` Letzte Meldung vom Server: ${letzterFehler}` : ''));
  }
  return { kanalId: kanal.id, anzahl: angekommen };
}
