/**
 * Die Oberfläche für den Server selbst — eine einzelne Seite ohne Baukasten.
 *
 * Bewusst ohne Aufbauwerkzeug: sie läuft auf einem Pi, soll ohne Umweg starten
 * und darf sich nicht am Bau der Chat-Oberfläche festhalten. Alles steckt in
 * dieser Datei — Aufbau, Aussehen, Verhalten.
 */
export const KONSOLE_SEITE = String.raw`<!doctype html>
<html lang="de">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Stellium — Server</title>
<style>
  :root {
    --grund: #070912;
    --karte: rgba(22, 26, 44, 0.72);
    --rand: rgba(255, 255, 255, 0.08);
    --randStark: rgba(255, 255, 255, 0.15);
    --text: #e9ebf5;
    --leise: #8f96b0;
    --violett: #7c5cff;
    --blau: #4d7cff;
    --gruen: #2fd6a0;
    --gelb: #ffc861;
    --rot: #ff6b7d;
    --r: 16px;
  }
  * { box-sizing: border-box; }
  html, body { height: 100%; }
  body {
    margin: 0;
    padding: 22px;
    font: 14px/1.55 -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, system-ui, sans-serif;
    color: var(--text);
    background: var(--grund);
    overflow-x: hidden;
  }

  /* Ruhig atmender Hintergrund — ein Serverfenster steht oft stundenlang offen. */
  .aurora { position: fixed; inset: 0; z-index: 0; overflow: hidden; }
  .aurora span {
    position: absolute; border-radius: 50%; filter: blur(90px); opacity: 0.5;
    animation: treiben 26s ease-in-out infinite;
  }
  .aurora span:nth-child(1) { width: 46vw; height: 46vw; left: -8vw; top: -12vw; background: #3b2d7a; }
  .aurora span:nth-child(2) { width: 38vw; height: 38vw; right: -6vw; top: 18vh; background: #123f52; animation-delay: -9s; }
  .aurora span:nth-child(3) { width: 32vw; height: 32vw; left: 28vw; bottom: -14vw; background: #4a1f52; animation-delay: -17s; }
  @keyframes treiben {
    0%, 100% { transform: translate(0, 0) scale(1); }
    33%      { transform: translate(4vw, -3vh) scale(1.08); }
    66%      { transform: translate(-3vw, 4vh) scale(0.95); }
  }
  @media (prefers-reduced-motion: reduce) { .aurora span { animation: none; } }

  .rahmen { position: relative; z-index: 1; max-width: 1180px; margin: 0 auto; }

  header { display: flex; align-items: center; gap: 14px; margin-bottom: 20px; }
  .logo {
    width: 42px; height: 42px; border-radius: 13px; display: grid; place-items: center;
    background: linear-gradient(135deg, var(--violett), var(--blau));
    box-shadow: 0 6px 22px rgba(124, 92, 255, 0.45);
    font-size: 20px;
  }
  h1 { margin: 0; font-size: 19px; font-weight: 650; letter-spacing: -0.02em; }
  .unter { color: var(--leise); font-size: 12.5px; }
  .kopfrechts { margin-left: auto; display: flex; gap: 8px; align-items: center; }

  .puls { width: 8px; height: 8px; border-radius: 50%; background: var(--gruen); animation: pulsen 2.4s ease-in-out infinite; }
  @keyframes pulsen { 0%, 100% { opacity: 1; transform: scale(1); } 50% { opacity: 0.45; transform: scale(0.85); } }

  .gitter { display: grid; grid-template-columns: repeat(auto-fit, minmax(268px, 1fr)); gap: 14px; }

  .karte {
    background: var(--karte);
    border: 1px solid var(--rand);
    border-radius: var(--r);
    padding: 16px 18px;
    backdrop-filter: blur(20px) saturate(150%);
    animation: auf 0.5s cubic-bezier(0.16, 1, 0.3, 1) backwards;
  }
  .karte:nth-child(1) { animation-delay: 0.02s; }
  .karte:nth-child(2) { animation-delay: 0.06s; }
  .karte:nth-child(3) { animation-delay: 0.10s; }
  .karte:nth-child(4) { animation-delay: 0.14s; }
  .karte:nth-child(5) { animation-delay: 0.18s; }
  .karte:nth-child(6) { animation-delay: 0.22s; }
  @keyframes auf { from { opacity: 0; transform: translateY(10px); } to { opacity: 1; transform: none; } }

  .karte h2 {
    margin: 0 0 12px; font-size: 11px; font-weight: 700;
    letter-spacing: 0.09em; text-transform: uppercase; color: var(--leise);
  }

  .zeile { display: flex; align-items: center; gap: 10px; padding: 5px 0; font-size: 13px; }
  .zeile .bez { color: var(--leise); min-width: 108px; }
  .zeile .wert { font-variant-numeric: tabular-nums; }
  .gruen { color: var(--gruen); } .gelb { color: var(--gelb); } .rot { color: var(--rot); }

  .ring { display: flex; align-items: center; gap: 14px; padding: 6px 0; }
  .ring svg { flex: none; transform: rotate(-90deg); }
  .ring circle { fill: none; stroke-width: 7; stroke-linecap: round; }
  .ring .bahn { stroke: rgba(255,255,255,0.08); }
  .ring .fuell { transition: stroke-dashoffset 0.7s cubic-bezier(0.16,1,0.3,1), stroke 0.4s; }
  .ring .zahl { font-size: 17px; font-weight: 650; font-variant-numeric: tabular-nums; }
  .ring .titel { font-size: 12px; color: var(--leise); }

  .balken { height: 6px; border-radius: 99px; background: rgba(255,255,255,0.07); overflow: hidden; margin-top: 5px; }
  .balken i { display: block; height: 100%; border-radius: 99px; transition: width 0.7s cubic-bezier(0.16,1,0.3,1); }

  .adresse {
    display: flex; align-items: center; gap: 8px;
    padding: 9px 11px; margin-bottom: 6px;
    border-radius: 10px; background: rgba(255,255,255,0.04);
    font-size: 13px; word-break: break-all;
  }
  .adresse b { font-weight: 600; color: #cfd6ff; }

  .zahlen { display: grid; grid-template-columns: repeat(3, 1fr); gap: 10px; }
  .zahl-kachel { text-align: center; padding: 12px 6px; border-radius: 12px; background: rgba(255,255,255,0.04); }
  .zahl-kachel .n { font-size: 21px; font-weight: 660; font-variant-numeric: tabular-nums; }
  .zahl-kachel .b { font-size: 10.5px; color: var(--leise); text-transform: uppercase; letter-spacing: 0.05em; }

  .knoepfe { display: flex; flex-wrap: wrap; gap: 8px; }
  button {
    display: inline-flex; align-items: center; gap: 7px;
    padding: 9px 14px; border-radius: 10px; cursor: pointer;
    font: inherit; font-size: 13px; color: var(--text);
    background: rgba(255,255,255,0.06); border: 1px solid var(--rand);
    transition: transform 0.14s, background 0.14s, border-color 0.14s;
  }
  button:hover { background: rgba(255,255,255,0.11); border-color: var(--randStark); transform: translateY(-1px); }
  button:active { transform: translateY(0); }
  button.wichtig { background: linear-gradient(135deg, var(--violett), var(--blau)); border-color: transparent; }
  button:disabled { opacity: 0.5; cursor: default; transform: none; }

  pre.ausgabe {
    margin: 12px 0 0; padding: 12px; max-height: 260px; overflow: auto;
    border-radius: 10px; background: rgba(0,0,0,0.35);
    font: 11.5px/1.5 ui-monospace, SFMono-Regular, Menlo, monospace;
    color: #c9d1e6; white-space: pre-wrap; word-break: break-word;
  }

  .wartung {
    display: flex; align-items: center; gap: 12px;
    padding: 12px 16px; margin-bottom: 14px;
    border-radius: var(--r);
    background: linear-gradient(90deg, rgba(255,200,97,0.2), var(--karte));
    border: 1px solid rgba(255,200,97,0.3);
    font-size: 13.5px;
  }

  footer { margin-top: 18px; text-align: center; color: var(--leise); font-size: 11.5px; }
</style>
</head>
<body>
<div class="aurora"><span></span><span></span><span></span></div>

<div class="rahmen">
  <header>
    <div class="logo">✦</div>
    <div>
      <h1>Stellium</h1>
      <div class="unter" id="geraet">…</div>
    </div>
    <div class="kopfrechts">
      <span class="puls" id="puls"></span>
      <span class="unter" id="stand">verbinde…</span>
    </div>
  </header>

  <div id="wartung"></div>

  <div class="gitter">
    <div class="karte">
      <h2>Verbinden</h2>
      <div id="adressen"></div>
      <div class="zeile"><span class="bez">Zertifikat</span><span class="wert" id="zert">—</span></div>
    </div>

    <div class="karte">
      <h2>Dienste</h2>
      <div class="zeile"><span class="bez">Chat</span><span class="wert" id="d-chat">—</span></div>
      <div class="zeile"><span class="bez">Webserver</span><span class="wert" id="d-nginx">—</span></div>
      <div class="zeile"><span class="bez">Tunnel</span><span class="wert" id="d-tunnel">—</span></div>
      <div class="zeile"><span class="bez">Übersetzung</span><span class="wert" id="d-ki">—</span></div>
      <div class="zeile"><span class="bez">Läuft seit</span><span class="wert" id="d-seit">—</span></div>
    </div>

    <div class="karte">
      <h2>Leistung</h2>
      <div class="ring">
        <svg width="62" height="62" viewBox="0 0 62 62">
          <circle class="bahn" cx="31" cy="31" r="26"></circle>
          <circle class="fuell" id="r-cpu" cx="31" cy="31" r="26" stroke="#7c5cff"
                  stroke-dasharray="163.4" stroke-dashoffset="163.4"></circle>
        </svg>
        <div><div class="zahl" id="t-cpu">—</div><div class="titel" id="u-cpu">Prozessor</div></div>
      </div>
      <div class="ring">
        <svg width="62" height="62" viewBox="0 0 62 62">
          <circle class="bahn" cx="31" cy="31" r="26"></circle>
          <circle class="fuell" id="r-ram" cx="31" cy="31" r="26" stroke="#4d7cff"
                  stroke-dasharray="163.4" stroke-dashoffset="163.4"></circle>
        </svg>
        <div><div class="zahl" id="t-ram">—</div><div class="titel" id="u-ram">Arbeitsspeicher</div></div>
      </div>
      <div class="zeile"><span class="bez">Speicherplatz</span><span class="wert" id="t-platte">—</span></div>
      <div class="balken"><i id="b-platte" style="width:0"></i></div>
      <div id="temp"></div>
    </div>

    <div class="karte">
      <h2>Im Chat</h2>
      <div class="zahlen">
        <div class="zahl-kachel"><div class="n" id="z-users">–</div><div class="b">Konten</div></div>
        <div class="zahl-kachel"><div class="n" id="z-channels">–</div><div class="b">Kanäle</div></div>
        <div class="zahl-kachel"><div class="n" id="z-messages">–</div><div class="b">Nachrichten</div></div>
      </div>
      <div class="zeile" style="margin-top:10px"><span class="bez">Heute</span><span class="wert" id="z-heute">—</span></div>
      <div class="zeile"><span class="bez">Übersetzt</span><span class="wert" id="z-ueber">—</span></div>
      <div class="zeile"><span class="bez">Weiteres</span><span class="wert" id="z-rest">—</span></div>
    </div>

    <div class="karte">
      <h2>Daten</h2>
      <div class="zeile"><span class="bez">Datenbank</span><span class="wert" id="s-db">—</span></div>
      <div class="zeile"><span class="bez">Sicherung</span><span class="wert" id="s-sich">—</span></div>
      <div class="knoepfe" style="margin-top:12px">
        <button onclick="tuWas('sichern', this)">Jetzt sichern</button>
        <button onclick="tuWas('update-pruefen', this)">Nach Update sehen</button>
      </div>
    </div>

    <div class="karte">
      <h2>Bedienen</h2>
      <div class="knoepfe">
        <button class="wichtig" onclick="neustart(this)">Chat neu starten</button>
        <button onclick="tuWas('protokoll', this)">Protokoll ansehen</button>
        <button onclick="location.reload()">Ansicht auffrischen</button>
      </div>
      <pre class="ausgabe" id="ausgabe" hidden></pre>
    </div>
  </div>

  <footer>Diese Ansicht ist nur auf diesem Gerät erreichbar.</footer>
</div>

<script>
const $ = (id) => document.getElementById(id);

function groesse(b) {
  if (!b && b !== 0) return '—';
  const e = ['B','KB','MB','GB','TB']; let w = b, i = 0;
  while (w >= 1024 && i < e.length - 1) { w /= 1024; i++; }
  return (w < 10 && i > 0 ? w.toFixed(1) : Math.round(w)) + ' ' + e[i];
}

function dauer(sek) {
  const t = Math.floor(sek / 86400), s = Math.floor((sek % 86400) / 3600), m = Math.floor((sek % 3600) / 60);
  if (t) return t + (t === 1 ? ' Tag, ' : ' Tage, ') + s + ' Std';
  if (s) return s + ' Std, ' + m + ' Min';
  return m + ' Min';
}

function ring(el, anteil) {
  const umfang = 163.4;
  el.style.strokeDashoffset = String(umfang * (1 - Math.min(1, Math.max(0, anteil))));
  el.setAttribute('stroke', anteil > 0.9 ? '#ff6b7d' : anteil > 0.75 ? '#ffc861' : el.id === 'r-cpu' ? '#7c5cff' : '#4d7cff');
}

function zustand(el, an, textAn, textAus) {
  el.textContent = an ? textAn : textAus;
  el.className = 'wert ' + (an ? 'gruen' : 'rot');
}

let letzterFehler = 0;

async function laden() {
  try {
    const d = await (await fetch('/api/system')).json();
    $('puls').style.background = 'var(--gruen)';
    $('stand').textContent = new Date(d.zeit).toLocaleTimeString('de-DE');
    $('geraet').textContent = d.modell;

    $('adressen').innerHTML = d.adressen.length
      ? d.adressen.map((a) => '<div class="adresse">🔒 <b>' + a + '</b></div>').join('')
      : '<div class="adresse">Noch keine Adresse eingerichtet</div>';

    $('zert').textContent = d.zertifikat ? d.zertifikat.name + ' · noch ' + d.zertifikat.tage + ' Tage' : 'keines';
    $('zert').className = 'wert ' + (!d.zertifikat ? 'gelb' : d.zertifikat.tage < 15 ? 'rot' : 'gruen');

    zustand($('d-chat'), d.dienste.chat, 'läuft', 'AUS');
    zustand($('d-nginx'), d.dienste.nginx, 'läuft', 'AUS');
    $('d-tunnel').textContent = d.dienste.tunnel ? 'läuft' : 'nicht eingerichtet';
    $('d-tunnel').className = 'wert ' + (d.dienste.tunnel ? 'gruen' : '');
    const kiAn = d.ai && d.ai.provider && d.ai.provider !== 'demo';
    $('d-ki').textContent = kiAn ? 'an · ' + (d.ai.model || d.ai.provider) : 'aus';
    $('d-ki').className = 'wert ' + (kiAn ? 'gruen' : 'gelb');
    $('d-seit').textContent = dauer(d.laeuftSeit);

    ring($('r-cpu'), d.leistung.cpu);
    $('t-cpu').textContent = Math.round(d.leistung.cpu * 100) + ' %';
    $('u-cpu').textContent = d.leistung.kerne + ' Kerne' + (d.leistung.takt ? ' · ' + Math.round(d.leistung.takt) + ' MHz' : '');

    const ramAnteil = d.leistung.ramBelegt / d.leistung.ramGesamt;
    ring($('r-ram'), ramAnteil);
    $('t-ram').textContent = Math.round(ramAnteil * 100) + ' %';
    $('u-ram').textContent = groesse(d.leistung.ramBelegt) + ' von ' + groesse(d.leistung.ramGesamt);

    if (d.leistung.platteGesamt) {
      const anteil = d.leistung.platteBelegt / d.leistung.platteGesamt;
      $('t-platte').textContent = groesse(d.leistung.platteGesamt - d.leistung.platteBelegt) + ' frei';
      const b = $('b-platte');
      b.style.width = (anteil * 100) + '%';
      b.style.background = anteil > 0.9 ? '#ff6b7d' : anteil > 0.75 ? '#ffc861' : '#2fd6a0';
    }

    $('temp').innerHTML = d.leistung.temperaturen.map((t) =>
      '<div class="zeile"><span class="bez">' + t.name + '</span><span class="wert ' +
      (t.grad > 78 ? 'rot' : t.grad > 65 ? 'gelb' : 'gruen') + '">' + t.grad + ' °C</span></div>').join('');

    const z = d.zahlen;
    $('z-users').textContent = z.users ?? '–';
    $('z-channels').textContent = z.channels ?? '–';
    $('z-messages').textContent = z.messages ?? '–';
    $('z-heute').textContent = (z.nachrichtenHeute ?? 0) + ' Nachrichten';
    $('z-ueber').textContent = (z.uebersetzungen ?? 0) + ' Übersetzungen';
    $('z-rest').textContent = [
      z.tasks ? z.tasks + ' Aufgaben' : null,
      z.events ? z.events + ' Termine' : null,
      z.files ? z.files + ' Dateien' : null,
      z.ideas ? z.ideas + ' Ideen' : null,
    ].filter(Boolean).join(' · ') || 'nichts bisher';

    $('s-db').textContent = groesse(d.datenbank);
    $('s-sich').textContent = d.sicherung
      ? d.sicherung.anzahl + ' Stände · letzter vor ' + Math.round(d.sicherung.alter / 3600000) + ' Std'
      : 'noch keiner';

    $('wartung').innerHTML = d.wartung
      ? '<div class="wartung">⏳ Serverstand <b>' + d.wartung.version + '</b> wird eingespielt — Start um ' +
        new Date(d.wartung.startetUm).toLocaleTimeString('de-DE') + ', etwa ' +
        Math.round(d.wartung.dauertEtwa / 60000) + ' Minuten</div>'
      : '';
  } catch (e) {
    letzterFehler = Date.now();
    $('puls').style.background = 'var(--rot)';
    $('stand').textContent = 'keine Verbindung';
  }
}

async function tuWas(aktion, knopf) {
  const alt = knopf.textContent;
  knopf.disabled = true; knopf.textContent = 'einen Moment…';
  try {
    const antwort = await (await fetch('/api/system/' + aktion, { method: 'POST' })).json();
    if (antwort.ausgabe) {
      const feld = $('ausgabe');
      feld.hidden = false;
      feld.textContent = antwort.ausgabe;
      feld.scrollTop = feld.scrollHeight;
    }
    knopf.textContent = 'erledigt';
  } catch {
    knopf.textContent = 'ging nicht';
  }
  setTimeout(() => { knopf.disabled = false; knopf.textContent = alt; }, 1800);
  laden();
}

async function neustart(knopf) {
  if (!confirm('Den Chat-Dienst neu starten? Alle Verbindungen brechen kurz ab.')) return;
  await tuWas('neustarten', knopf);
}

laden();
setInterval(laden, 3000);
</script>
</body>
</html>`;
