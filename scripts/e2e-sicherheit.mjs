import { probeserver } from './probeserver.mjs';

/* Eigener Server statt der Entwicklungsdatenbank: diese Prüfung legt Konten an
   und braucht dafür volle Rechte. Auf der gemeinsamen Datenbank ist das
   Testkonto ein gewöhnliches Mitglied — jeder Lauf endete dort mit 403. */
const probe = await probeserver();
const S = probe.S;
const LOGIN = probe.login;
const PW = probe.passwort;
/**
 * Prüft die Zugangsregeln des Servers — die Stellen, an denen ein Fehler
 * bedeutet, dass jemand etwas sieht oder tut, was ihm nicht zusteht.
 */

const ergebnisse = [];
const pruefe = async (n, f) => {
  try { const x = await f(); ergebnisse.push(1); console.log(`  ✓ ${n}${x ? ` — ${x}` : ''}`); }
  catch (e) { ergebnisse.push(0); console.log(`  ✗ ${n} — ${e.message}`); }
};
const muss = (b, m) => { if (!b) throw new Error(m); };

const anmelden = async (login, passwort) =>
  (await (await fetch(`${S}/api/auth/login`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ login, password: passwort }),
  })).json());

const ich = await anmelden(LOGIN, PW);
if (!ich.token) { console.error('Anmeldung fehlgeschlagen.'); process.exit(1); }
const meinKopf = { authorization: `Bearer ${ich.token}` };

/** Eine zweite Person, die in nichts drin ist. */
const marke = Date.now().toString(36).slice(-5);
const neu = await (await fetch(`${S}/api/admin/users`, {
  method: 'POST', headers: { 'content-type': 'application/json', ...meinKopf },
  body: JSON.stringify({ displayName: `Fremde ${marke}`, handle: `fremde${marke}`, role: 'member', language: 'de' }),
})).json();
const ersteAnmeldung = await anmelden(neu.credential.handle, neu.credential.oneTimePassword);
await fetch(`${S}/api/auth/setup`, {
  method: 'POST',
  headers: { 'content-type': 'application/json', authorization: `Bearer ${ersteAnmeldung.token}` },
  body: JSON.stringify({ newPassword: `Fremdes-Passwort-${marke}` }),
});
const fremde = await anmelden(neu.credential.handle, `Fremdes-Passwort-${marke}`);
const fremderKopf = { authorization: `Bearer ${fremde.token}` };

/** Über die WebSocket-Verbindung ein Ereignis schicken und die Antwort abwarten. */
function ueberWs(token, ereignis, warteAuf, passt = null) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(S.replace(/^http/, 'ws') + '/ws');
    const timer = setTimeout(() => { ws.close(); reject(new Error('Zeitüberschreitung')); }, 12000);
    let bereit = false;
    ws.onopen = () => ws.send(JSON.stringify({ t: 'auth', token, protocol: 1 }));
    ws.onmessage = (e) => {
      const ev = JSON.parse(e.data);
      if (ev.t === 'ready' && !bereit) {
        bereit = true;
        ws.send(JSON.stringify(typeof ereignis === 'function' ? ereignis(ev) : ereignis));
        return;
      }
      // Seit der Server Kanalübersetzungen nachliefert, kommen laufend
      // channel:upsert-Meldungen. Nur die zum gefragten Kanal zählt.
      if (bereit && ev.t === warteAuf) {
        const gemeint = typeof ereignis === 'object' ? ereignis.channelId : null;
        if (gemeint && ev.channel && ev.channel.id !== gemeint) return;
        /* Gleich nach dem Verbinden schickt der Server die vorhandenen Kanäle.
           Ohne diesen Filter nahm der Test den ersten davon für den eben
           angelegten — und prüfte danach an einem öffentlichen Kanal, was für
           einen privaten gelten sollte. Vier Prüfungen waren damit wertlos. */
        if (passt && !passt(ev)) return;
        clearTimeout(timer); ws.close(); resolve(ev);
      }
      if (bereit && ev.t === 'error') { clearTimeout(timer); ws.close(); resolve(ev); }
    };
    ws.onerror = () => { clearTimeout(timer); reject(new Error('Verbindungsfehler')); };
  });
}

console.log('\nZugangsregeln');

// Öffentliche Kanäle stehen allen offen — der Test braucht einen privaten.
const geheimerKanal = await ueberWs(ich.token,
  { t: 'channel:create', kind: 'private', name: `vertraulich-${marke}` }, 'channel:upsert',
  (ev) => ev.channel?.name === `vertraulich-${marke}`);
const geheimeKanalId = geheimerKanal.channel?.id;

const privat = await ueberWs(ich.token,
  { t: 'message:send', clientId: 'sec', channelId: geheimeKanalId, text: `Vertraulich ${marke}` },
  'message:new');
const geheimeId = privat.message?.id;

await pruefe('Fremde kann fremde Nachricht nicht übersetzen lassen', async () => {
  muss(geheimeId, 'keine Testnachricht');
  const antwort = await ueberWs(fremde.token, { t: 'translate:request', messageId: geheimeId, targetLang: 'en' }, 'translation');
  muss(antwort.t === 'error', `bekam ${antwort.t} statt einer Abweisung`);
  return antwort.message;
});

await pruefe('Fremde kann fremden Thread nicht öffnen', async () => {
  const antwort = await ueberWs(fremde.token, { t: 'thread:open', messageId: geheimeId }, 'thread:history');
  muss(antwort.t === 'error', `bekam ${antwort.t} statt einer Abweisung`);
});

await pruefe('Fremde kann fremde Nachricht nicht merken', async () => {
  // Gelingt es, antwortet der Server gar nicht — deshalb zählt hier, dass ein
  // Fehler kommt, und eine Zeitüberschreitung bedeutet: es ging durch.
  const antwort = await ueberWs(fremde.token, { t: 'message:save', messageId: geheimeId, saved: true }, 'error')
    .catch(() => ({ t: 'durchgelassen' }));
  muss(antwort.t === 'error', 'die Nachricht wurde ohne Zugang gemerkt');
});

await pruefe('Private Kanäle lassen sich nicht betreten', async () => {
  muss(geheimeKanalId, 'kein privater Kanal angelegt');
  const antwort = await ueberWs(fremde.token, { t: 'channel:join', channelId: geheimeKanalId }, 'channel:upsert',
    (ev) => ev.channel?.id === geheimeKanalId);
  muss(antwort.t === 'error', `bekam ${antwort.t} statt einer Abweisung`);
});

console.log('\nDateien');

await pruefe('Download braucht einen Nachweis', async () => {
  const form = new FormData();
  form.append('file', new Blob([`Inhalt ${marke}`]), 'geheim.txt');
  const up = await (await fetch(`${S}/api/files`, { method: 'POST', headers: meinKopf, body: form })).json();
  muss(up.file, 'nicht hochgeladen');
  const ohne = await fetch(`${S}${up.file.url}`);
  muss(ohne.status === 401, `Status ${ohne.status} statt 401`);
  const falsch = await fetch(`${S}${up.file.url}?token=unsinn`);
  muss(falsch.status === 401, `mit falschem Nachweis Status ${falsch.status}`);
  const richtig = await fetch(`${S}${up.file.url}?token=${encodeURIComponent(ich.token)}`);
  muss(richtig.status === 200, `mit Nachweis Status ${richtig.status}`);
  muss((await richtig.text()) === `Inhalt ${marke}`, 'Inhalt weicht ab');
});

console.log('\nAnmeldung');

await pruefe('Durchprobieren wird ausgebremst', async () => {
  const opfer = `probier${marke}`;
  let letzter = 0;
  for (let i = 0; i < 12; i += 1) {
    const r = await fetch(`${S}/api/auth/login`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ login: opfer, password: `falsch${i}` }),
    });
    letzter = r.status;
    if (letzter === 429) break;
  }
  muss(letzter === 429, `nach zwölf Versuchen immer noch ${letzter}`);
});

await pruefe('Die Bremse trifft nur das betroffene Konto', async () => {
  const r = await anmelden(LOGIN, PW);
  muss(r.token, 'die eigene Anmeldung ist mitgesperrt');
});

console.log('\nVersionen');

await pruefe('Ohne Verwaltungsrecht keine neue Version', async () => {
  const form = new FormData();
  form.append('version', '99.0.0');
  form.append('file', new Blob(['nicht echt']), 'boes.dmg');
  const r = await fetch(`${S}/api/releases/darwin`, { method: 'POST', headers: fremderKopf, body: form });
  muss(r.status === 403, `Status ${r.status} statt 403`);
});


console.log('\nAnhänge');

await pruefe('Anhang ohne Anmeldung bleibt zu', async () => {
  const form = new FormData();
  form.append('file', new Blob([Buffer.from('geheimer inhalt')], { type: 'text/plain' }), 'geheim.txt');
  const hoch = await (await fetch(`${S}/api/uploads`, { method: 'POST', headers: meinKopf, body: form })).json();
  const pfad = hoch.attachment?.url ?? hoch.url;
  muss(pfad, 'kein Anhang angelegt');
  const ohne = await fetch(`${S}${pfad}`);
  muss(ohne.status === 401, `bekam ${ohne.status} statt 401`);
  return `${ohne.status} ohne Nachweis`;
});

await pruefe('Anhang im privaten Kanal bleibt für Fremde zu', async () => {
  const form = new FormData();
  form.append('file', new Blob([Buffer.from('vertraulich')], { type: 'text/plain' }), 'v.txt');
  const hoch = await (await fetch(`${S}/api/uploads`, { method: 'POST', headers: meinKopf, body: form })).json();
  const anhang = hoch.attachment ?? hoch;
  await ueberWs(ich.token, {
    t: 'message:send', clientId: 'sec2', channelId: geheimeKanalId,
    text: 'mit Anhang', attachmentIds: [anhang.id],
  }, 'message:new');
  const antwort = await fetch(`${S}${anhang.url}?token=${encodeURIComponent(fremde.token)}`);
  muss(antwort.status === 404, `bekam ${antwort.status} statt 404`);
});

console.log('\nRechte');

await pruefe('Die eigene Rolle lässt sich nicht ändern', async () => {
  const antwort = await fetch(`${S}/api/admin/users/${ich.self?.id ?? ich.user?.id}/role`, {
    method: 'POST', headers: { 'content-type': 'application/json', ...meinKopf },
    body: JSON.stringify({ role: 'owner' }),
  });
  muss(antwort.status === 403, `bekam ${antwort.status} statt 403`);
});

await pruefe('Planen in einen fremden Kanal wird abgewiesen', async () => {
  const antwort = await ueberWs(fremde.token, {
    t: 'message:schedule', channelId: geheimeKanalId, text: 'heimlich',
    sendAt: Date.now() + 600000,
  }, 'scheduled:upsert');
  muss(antwort.t === 'error', `bekam ${antwort.t} statt einer Abweisung`);
});

await pruefe('Verlauf lässt sich nicht mit negativer Grenze abräumen', async () => {
  const antwort = await ueberWs(ich.token,
    { t: 'channel:open', channelId: geheimeKanalId, limit: -1 }, 'channel:history');
  muss(Array.isArray(antwort.messages), 'kein Verlauf gekommen');
  muss(antwort.messages.length <= 100, `bekam ${antwort.messages.length} Nachrichten`);
  return `${antwort.messages.length} statt alles`;
});

await pruefe('Gelöschtes Konto kommt nicht mehr herein', async () => {
  const weg = await (await fetch(`${S}/api/admin/users`, {
    method: 'POST', headers: { 'content-type': 'application/json', ...meinKopf },
    body: JSON.stringify({ displayName: `Weg ${marke}`, handle: `weg${marke}`, role: 'member', language: 'de' }),
  })).json();
  const erste = await anmelden(weg.credential.handle, weg.credential.oneTimePassword);
  await fetch(`${S}/api/auth/setup`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${erste.token}` },
    body: JSON.stringify({ newPassword: `Weg-Passwort-${marke}` }),
  });
  const sitzung = await anmelden(weg.credential.handle, `Weg-Passwort-${marke}`);
  await fetch(`${S}/api/admin/users/${weg.credential.userId}`, { method: 'DELETE', headers: meinKopf });
  // Das Token ist weiter gültig — der Server muss es trotzdem abweisen.
  const antwort = await ueberWs(sitzung.token, { t: 'channel:list' }, 'channel:list')
    .catch(() => ({ t: 'zeitueberschreitung' }));
  muss(antwort.t !== 'channel:list', 'das gelöschte Konto durfte weiterarbeiten');
});

await probe.stop();


const schlecht = ergebnisse.filter((x) => !x).length;
console.log(`\n${ergebnisse.length - schlecht}/${ergebnisse.length} bestanden`);
process.exit(schlecht ? 1 : 0);
