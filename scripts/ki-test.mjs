const B = 'http://localhost:8787';
const pw = process.argv[2];
const login = await (await fetch(B+'/api/auth/login',{method:'POST',headers:{'content-type':'application/json'},
  body:JSON.stringify({login:'pruefr79z',password:pw})})).json();
if (!login.token) { console.error('Login fehlgeschlagen:', login); process.exit(1); }

const ws = new WebSocket('ws://localhost:8787/ws');
const h = new Map();
ws.onopen = () => ws.send(JSON.stringify({t:'auth',token:login.token,protocol:1}));
ws.onmessage = e => { const ev=JSON.parse(e.data); (h.get(ev.t)??[]).forEach(f=>f(ev));
  if (ev.t==='error') console.log('  FEHLER:', ev.message); };
const on = (t,f) => h.set(t,[...(h.get(t)??[]),f]);
const once = t => new Promise(r => on(t,r));

const ready = await once('ready');
console.log('Verbunden. KI:', ready.ai.provider, '|', ready.ai.model);

// ── Privater KI-Chat ──
console.log('\n--- Privater KI-Chat ---');
const kanalP = once('channel:upsert');
ws.send(JSON.stringify({t:'ai:open-chat'}));
const dm = (await kanalP).channel;
console.log(`  Kanal geöffnet: ${dm.kind}, KI-Modus "${dm.aiMode}"`);

let denkt = false;
on('ai:thinking', ev => { if (ev.active) denkt = true; });

const frage = 'Wir haben drei Teams in Berlin, London und Tokio. Nenne mir in zwei Sätzen den besten Zeitpunkt für ein gemeinsames Meeting.';
console.log(`  ich: ${frage.slice(0,60)}…`);
const t0 = Date.now();
const antwortP = new Promise(r => on('message:new', ev => {
  if (ev.message.channelId === dm.id && ev.message.userId !== ready.self.id) r(ev.message);
}));
ws.send(JSON.stringify({t:'message:send',clientId:'k1',channelId:dm.id,text:frage}));
const antwort = await Promise.race([antwortP, new Promise(r=>setTimeout(()=>r(null),45000))]);
if (!antwort) { console.log('  KEINE ANTWORT nach 45s'); }
else {
  console.log(`  "denkt nach" gesendet: ${denkt ? 'ja' : 'nein'}`);
  console.log(`  KI (${Date.now()-t0}ms): ${antwort.text.replace(/\n/g,' ').slice(0,180)}`);
}

// ── Gemeinsamer Kanal ──
console.log('\n--- Gemeinsamer KI-Kanal ---');
const kanalT = once('channel:history');
ws.send(JSON.stringify({t:'ai:open-team-channel'}));
const team = await kanalT;
const teamKanal = ready.channels.find(c=>c.name==='ki-team') ?? { id: team.channelId };
console.log(`  Kanal: ki-team (${team.messages.length} Nachrichten)`);

const frage2 = 'Fasse in einem Satz zusammen, wofür dieser Kanal da ist.';
console.log(`  ich: ${frage2}`);
const antwort2P = new Promise(r => on('message:new', ev => {
  if (ev.message.channelId === team.channelId && ev.message.userId !== ready.self.id) r(ev.message);
}));
ws.send(JSON.stringify({t:'message:send',clientId:'k2',channelId:team.channelId,text:frage2}));
const antwort2 = await Promise.race([antwort2P, new Promise(r=>setTimeout(()=>r(null),45000))]);
console.log(antwort2 ? `  KI: ${antwort2.text.replace(/\n/g,' ').slice(0,180)}` : '  KEINE ANTWORT');

// ── Auf Englisch fragen -> muss auf Englisch antworten ──
console.log('\n--- Sprache folgt der Frage ---');
const frage3 = 'Please answer in one short sentence: what is the capital of Japan?';
console.log(`  ich (EN): ${frage3}`);
const antwort3P = new Promise(r => on('message:new', ev => {
  if (ev.message.channelId === dm.id && ev.message.userId !== ready.self.id) r(ev.message);
}));
ws.send(JSON.stringify({t:'message:send',clientId:'k3',channelId:dm.id,text:frage3}));
const antwort3 = await Promise.race([antwort3P, new Promise(r=>setTimeout(()=>r(null),45000))]);
if (antwort3) {
  console.log(`  KI: ${antwort3.text.replace(/\n/g,' ').slice(0,140)}`);
  console.log(`  erkannte Sprache: ${antwort3.sourceLang}`);
  console.log(`  Übersetzung für mich (de): ${antwort3.translation ? '"'+antwort3.translation.text.slice(0,90)+'"' : 'kommt nach'}`);
}
process.exit(0);
