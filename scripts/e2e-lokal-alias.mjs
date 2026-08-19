/** AI_PROVIDER=local muss nach dem Update weiter greifen — nicht auf Demo fallen. */
import { execFileSync } from 'node:child_process';

const ergebnisse = [];
const pruefe = (n, f) => {
  try { const x = f(); ergebnisse.push(1); console.log(`  ✓ ${n}${x ? ` — ${x}` : ''}`); }
  catch (e) { ergebnisse.push(0); console.log(`  ✗ ${n} — ${e.message.split('\n')[0]}`); }
};
const muss = (b, m) => { if (!b) throw new Error(m); };

/** Den Server mit einer Umgebung starten und fragen, was er daraus macht. */
const mitUmgebung = (umgebung) => {
  const код = `
    import('./dist/config.js').then(async (c) => {
      const t = await import('./dist/translation/index.js');
      console.log(JSON.stringify({
        anbieter: c.aktiverAnbieter(),
        lokal: c.istLokal(),
        eingerichtet: c.aiConfigured(),
        assistent: c.assistantAvailable(),
        adresse: c.istLokal() ? c.lokaleEinstellung().baseUrl : null,
        modell: c.istLokal() ? c.lokaleEinstellung().model : null,
        name: t.provider.name,
      }));
    });
  `;
  const roh = execFileSync('node', ['--input-type=module', '-e', код], {
    cwd: 'packages/server', encoding: 'utf8',
    env: { ...process.env, ...umgebung, DATA_DIR: '../../data' },
    stdio: ['ignore', 'pipe', 'ignore'],
  });
  return JSON.parse(roh.trim().split('\n').pop());
};

pruefe('AI_PROVIDER=local wird erkannt', () => {
  const r = mitUmgebung({ AI_PROVIDER: 'local', LOCAL_BASE_URL: 'http://127.0.0.1:11434/v1', LOCAL_MODEL: 'qwen3-8b' });
  muss(r.anbieter === 'local', `Anbieter ${r.anbieter}`);
  muss(r.lokal, 'gilt nicht als lokal');
  muss(r.eingerichtet, 'gilt als nicht eingerichtet — genau der Rückfall auf Demo');
  muss(r.assistent, 'Assistent wäre aus');
  muss(r.name !== 'demo', `Anbieter wäre "${r.name}"`);
  return `${r.name} · ${r.modell} · ${r.adresse}`;
});

pruefe('Auch mit AI_* statt LOCAL_*', () => {
  const r = mitUmgebung({ AI_PROVIDER: 'local', AI_BASE_URL: 'http://192.168.1.50:11434/v1', AI_MODEL: 'gemma3:4b' });
  muss(r.adresse === 'http://192.168.1.50:11434/v1', `Adresse ${r.adresse}`);
  muss(r.modell === 'gemma3:4b', `Modell ${r.modell}`);
  return `${r.modell} · ${r.adresse}`;
});

pruefe('Ohne jede Adresse trotzdem der übliche Port', () => {
  const r = mitUmgebung({ AI_PROVIDER: 'local' });
  muss(r.eingerichtet, 'fällt auf Demo zurück');
  muss(r.adresse?.includes('11434'), `Adresse ${r.adresse}`);
});

pruefe('ollama und llamacpp bleiben getrennt', () => {
  const a = mitUmgebung({ AI_PROVIDER: 'ollama' });
  const b = mitUmgebung({ AI_PROVIDER: 'llamacpp' });
  muss(a.adresse.includes('11434'), `ollama → ${a.adresse}`);
  muss(b.adresse.includes('8080'), `llamacpp → ${b.adresse}`);
  return `${a.adresse} / ${b.adresse}`;
});

pruefe('Groq bleibt unberührt', () => {
  const r = mitUmgebung({ AI_PROVIDER: 'groq' });
  muss(!r.lokal, 'gilt fälschlich als lokal');
  muss(r.name === 'groq' || r.name === 'demo', `Anbieter ${r.name}`);
});

const schlecht = ergebnisse.filter((x) => !x).length;
console.log(`\n${ergebnisse.length - schlecht}/${ergebnisse.length} bestanden`);
process.exit(schlecht ? 1 : 0);
