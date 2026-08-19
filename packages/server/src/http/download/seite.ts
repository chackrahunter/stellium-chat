import type { ReleaseInfo } from '@stellium/shared';

/**
 * Die Seite zum Herunterladen der Apps.
 *
 * Bewusst eine einzelne, in sich geschlossene Seite ohne Baustein-Gerüst: sie
 * soll auch dann erscheinen, wenn von der Oberfläche noch nichts geladen ist —
 * und wer sie besucht, hat meist noch gar keine App.
 */

export type Erkannt = 'darwin' | 'win32' | 'linux' | null;

const NAMEN: Record<string, { name: string; hinweis: string; symbol: string }> = {
  darwin: { name: 'macOS', hinweis: 'Apple Silicon und Intel', symbol: '🍎' },
  win32: { name: 'Windows', hinweis: 'Installationsprogramm', symbol: '⊞' },
  linux: { name: 'Linux', hinweis: 'AppImage', symbol: '🐧' },
};

/** Aus der Kennung des Browsers auf das System schließen. */
export function systemErkennen(userAgent: string): Erkannt {
  const ua = userAgent.toLowerCase();
  // iPhone und iPad zuerst: dort steht ebenfalls "mac os x" in der Kennung.
  if (/iphone|ipad|ipod|android/.test(ua)) return null;
  if (/mac os x|macintosh/.test(ua)) return 'darwin';
  if (/windows/.test(ua)) return 'win32';
  if (/linux|x11|cros/.test(ua)) return 'linux';
  return null;
}

const groesse = (bytes: number): string => {
  const mb = bytes / 1024 / 1024;
  return mb >= 1024 ? `${(mb / 1024).toFixed(1)} GB` : `${Math.round(mb)} MB`;
};

const schuetzen = (t: string): string =>
  t.replace(/[&<>"']/g, (z) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[z]!));

export function downloadSeite(input: {
  releases: ReleaseInfo[];
  erkannt: Erkannt;
  arbeitsbereich: string;
}): string {
  const apps = input.releases.filter((r) => r.platform !== 'server');
  const empfohlen = apps.find((r) => r.platform === input.erkannt) ?? null;
  const rest = apps.filter((r) => r !== empfohlen);
  const neueste = apps.map((r) => r.version).sort().pop() ?? null;

  const karte = (r: ReleaseInfo, gross: boolean) => {
    const n = NAMEN[r.platform] ?? { name: r.platform, hinweis: '', symbol: '•' };
    const datum = new Date(r.publishedAt).toLocaleDateString('de-DE', { day: 'numeric', month: 'long', year: 'numeric' });
    return `
      <a class="karte${gross ? ' karte--gross' : ''}" href="/download/${r.platform}">
        <span class="karte__symbol">${n.symbol}</span>
        <span class="karte__text">
          <strong>${schuetzen(n.name)}</strong>
          <span class="karte__unten">Version ${schuetzen(r.version)} · ${groesse(r.size)} · ${schuetzen(n.hinweis)}</span>
          ${gross ? `<span class="karte__datum">veröffentlicht am ${datum}</span>` : ''}
        </span>
        <span class="karte__pfeil">↓</span>
      </a>`;
  };

  const notizen = (empfohlen ?? apps[0])?.notes?.trim();

  return `<!doctype html>
<html lang="de">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<meta name="robots" content="noindex, nofollow" />
<title>${schuetzen(input.arbeitsbereich)} herunterladen</title>
<style>
  :root {
    color-scheme: dark;
    --tinte: #e8eaf6; --leise: #9aa0bd; --grund: #070912; --karte: rgba(255,255,255,.045);
    --linie: rgba(255,255,255,.10); --violett: #7c5cff; --cyan: #22d3ee;
  }
  * { box-sizing: border-box; }
  body {
    margin: 0; min-height: 100vh; padding: 5vh 20px 60px;
    background: radial-gradient(1000px 600px at 20% -10%, rgba(124,92,255,.20), transparent 60%),
                radial-gradient(900px 500px at 90% 10%, rgba(34,211,238,.13), transparent 60%), var(--grund);
    color: var(--tinte);
    font: 15px/1.55 -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
    display: flex; justify-content: center;
  }
  .huelle { width: min(680px, 100%); }
  .marke { display: flex; align-items: center; gap: 11px; margin-bottom: 34px; }
  .stern {
    width: 40px; height: 40px; border-radius: 12px; display: grid; place-items: center;
    background: linear-gradient(135deg, var(--violett), var(--cyan)); font-size: 20px;
  }
  h1 { margin: 0 0 6px; font-size: 30px; letter-spacing: -.02em; }
  .unterzeile { margin: 0 0 30px; color: var(--leise); }
  .abschnitt { margin: 0 0 12px; font-size: 12px; letter-spacing: .09em; text-transform: uppercase; color: var(--leise); }
  .karte {
    display: flex; align-items: center; gap: 15px; padding: 15px 17px; margin-bottom: 10px;
    border: 1px solid var(--linie); border-radius: 15px; background: var(--karte);
    color: inherit; text-decoration: none; transition: border-color .15s, transform .15s, background .15s;
  }
  .karte:hover { border-color: rgba(124,92,255,.65); transform: translateY(-1px); background: rgba(255,255,255,.07); }
  .karte--gross { padding: 21px; border-color: rgba(124,92,255,.5); background: linear-gradient(135deg, rgba(124,92,255,.14), rgba(34,211,238,.07)); }
  .karte__symbol { font-size: 26px; width: 34px; text-align: center; }
  .karte__text { display: flex; flex-direction: column; gap: 3px; min-width: 0; flex: 1; }
  .karte--gross strong { font-size: 19px; }
  .karte__unten, .karte__datum { color: var(--leise); font-size: 13px; }
  .karte__datum { font-size: 12px; }
  .karte__pfeil { font-size: 19px; color: var(--leise); }
  .karte:hover .karte__pfeil { color: var(--tinte); }
  .neu { margin: 30px 0 0; padding: 17px 19px; border: 1px solid var(--linie); border-radius: 15px; background: var(--karte); }
  .neu h2 { margin: 0 0 9px; font-size: 13px; letter-spacing: .09em; text-transform: uppercase; color: var(--leise); }
  .neu ul { margin: 0; padding-left: 19px; }
  .neu li { margin-bottom: 5px; color: var(--leise); }
  .fuss { margin-top: 34px; color: var(--leise); font-size: 13px; }
  .fuss a { color: var(--tinte); }
  .leer { padding: 24px; border: 1px dashed var(--linie); border-radius: 15px; color: var(--leise); text-align: center; }
  @media (max-width: 560px) { h1 { font-size: 25px; } body { padding-top: 3vh; } }
</style>
</head>
<body>
  <div class="huelle">
    <div class="marke">
      <div class="stern">✦</div>
      <div>
        <div style="font-weight:600">${schuetzen(input.arbeitsbereich)}</div>
        <div style="color:var(--leise);font-size:13px">Team-Chat, der jede Sprache spricht</div>
      </div>
    </div>

    <h1>App herunterladen</h1>
    <p class="unterzeile">
      ${neueste ? `Aktuell ist Version ${schuetzen(neueste)}.` : 'Noch ist keine Fassung hinterlegt.'}
      Nach der Installation hältst sich die App von selbst aktuell.
    </p>

    ${apps.length === 0 ? '<div class="leer">Hier liegt noch nichts bereit.</div>' : ''}

    ${empfohlen ? `<p class="abschnitt">Für dieses Gerät</p>${karte(empfohlen, true)}` : ''}

    ${rest.length ? `<p class="abschnitt" style="margin-top:26px">${empfohlen ? 'Andere Systeme' : 'Alle Systeme'}</p>${rest.map((r) => karte(r, false)).join('')}` : ''}

    ${notizen ? `<div class="neu"><h2>Neu in dieser Fassung</h2><ul>${
      notizen.split('\n').filter(Boolean).slice(0, 8).map((z) => `<li>${schuetzen(z.trim())}</li>`).join('')
    }</ul></div>` : ''}

    <p class="fuss">
      Kein Konto? Die Team-Leitung legt eines an — eine Selbstregistrierung gibt es bewusst nicht.
      <br />Lieber ohne Installation: <a href="/">im Browser öffnen</a>.
    </p>
  </div>
</body>
</html>`;
}
