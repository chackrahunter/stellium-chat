/** Bilder müssen vor dem Hochladen kleiner werden — sonst hilft nichts. */
import { chromium } from 'playwright';

const b = await chromium.launch({ headless: true });
const p = await (await b.newContext({ viewport: { width: 1280, height: 900 }, locale: 'de-DE' })).newPage();
await p.goto('http://localhost:5173');

const ergebnis = await p.evaluate(async () => {
  // Ein Foto in Telefongröße erzeugen: 4032 × 3024, wie es eine Kamera liefert.
  const f = document.createElement('canvas');
  f.width = 4032; f.height = 3024;
  const s = f.getContext('2d');
  const g = s.createLinearGradient(0, 0, 4032, 3024);
  g.addColorStop(0, '#7c5cff'); g.addColorStop(0.5, '#22d3ee'); g.addColorStop(1, '#f472b6');
  s.fillStyle = g; s.fillRect(0, 0, 4032, 3024);
  // Rauschen, damit es sich nicht unrealistisch gut komprimiert.
  for (let i = 0; i < 60000; i++) {
    s.fillStyle = `rgba(${Math.random()*255|0},${Math.random()*255|0},${Math.random()*255|0},0.5)`;
    s.fillRect(Math.random()*4032, Math.random()*3024, 6, 6);
  }
  const blob = await new Promise((f2) => f.toBlob(f2, 'image/jpeg', 0.92));
  const datei = new File([blob], 'foto.jpg', { type: 'image/jpeg' });

  const mod = await import('/src/lib/bilder.ts');
  const r = await mod.bildVerkleinern(datei);
  const bild = await createImageBitmap(r.datei);
  return { vorher: r.vorher, nachher: r.nachher, breite: bild.width, hoehe: bild.height, typ: r.datei.type };
});

const mb = (n) => (n / 1048576).toFixed(2) + ' MB';
console.log(`  Vorher:  ${mb(ergebnis.vorher)} (4032 × 3024)`);
console.log(`  Nachher: ${mb(ergebnis.nachher)} (${ergebnis.breite} × ${ergebnis.hoehe}, ${ergebnis.typ})`);
const faktor = ergebnis.vorher / ergebnis.nachher;
console.log(`  Faktor:  ${faktor.toFixed(1)}×`);
console.log(`  Bei 2,5 MB/s: ${(ergebnis.vorher / 2621440).toFixed(1)} s → ${(ergebnis.nachher / 2621440).toFixed(1)} s`);
await b.close();
process.exit(faktor > 2 ? 0 : 1);
