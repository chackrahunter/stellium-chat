/**
 * Erzeugt die App-Icons ohne Bildbibliothek: die Grafik wird als Pixelfeld
 * berechnet und als PNG geschrieben (zlib steckt in Node).
 *
 *   node scripts/make-icons.mjs
 *
 * Ergebnis: packages/desktop/build/icon.png (1024), icon.icns, icon.ico
 */
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const outDir = path.join(root, 'packages/desktop/build');
fs.mkdirSync(outDir, { recursive: true });

/* ── Zeichnen ─────────────────────────────────────────────────── */

const VIOLET = [0x7c, 0x5c, 0xff];
const CYAN   = [0x22, 0xd3, 0xee];
const PINK   = [0xf4, 0x72, 0xb6];

const lerp = (a, b, t) => a + (b - a) * t;
const mix = (c1, c2, t) => [lerp(c1[0], c2[0], t), lerp(c1[1], c2[1], t), lerp(c1[2], c2[2], t)];
const clamp01 = (v) => (v < 0 ? 0 : v > 1 ? 1 : v);

/** Abstand zum Rand einer abgerundeten Fläche (negativ = innen). */
function roundedRectSdf(x, y, halfW, halfH, radius) {
  const qx = Math.abs(x) - halfW + radius;
  const qy = Math.abs(y) - halfH + radius;
  const outside = Math.hypot(Math.max(qx, 0), Math.max(qy, 0));
  return outside + Math.min(Math.max(qx, qy), 0) - radius;
}

/**
 * Vierzackiger Funkel-Stern. Über die Potenz der Achsenabstände bekommen
 * die Zacken ihre konkav geschwungene Form.
 */
function sparkle(x, y, size) {
  const ax = Math.abs(x) / size;
  const ay = Math.abs(y) / size;
  return Math.pow(ax, 0.5) + Math.pow(ay, 0.5) - 1;
}

/** Farbe und Deckkraft eines Punktes im Einheitsquadrat [-0.5, 0.5]. */
function shade(x, y) {
  // Hintergrund: abgerundetes Quadrat im macOS-Stil
  const body = roundedRectSdf(x, y, 0.44, 0.44, 0.098);
  if (body > 0.004) return null;

  // Diagonaler Verlauf violett -> cyan, mit einem Hauch Pink oben rechts
  const t = clamp01((x + y + 0.9) / 1.8);
  let color = mix(VIOLET, CYAN, t);
  const pinkT = clamp01(1 - Math.hypot(x - 0.3, y + 0.32) * 2.2);
  color = mix(color, PINK, pinkT * 0.55);

  // Sanfte Aufhellung oben links, damit die Fläche nicht flach wirkt
  const sheen = clamp01(1 - Math.hypot(x + 0.22, y + 0.26) * 1.7);
  color = mix(color, [255, 255, 255], sheen * 0.16);

  // Kleine Sterne im Hintergrund
  for (const [sx, sy, ss] of [[-0.26, 0.24, 0.032], [0.28, 0.18, 0.024], [0.2, -0.3, 0.02]]) {
    const d = sparkle(x - sx, y - sy, ss);
    if (d < 0) color = mix(color, [255, 255, 255], clamp01(-d * 2.4) * 0.8);
  }

  // Hauptstern mit weichem Schein
  const glow = sparkle(x, y, 0.30);
  if (glow < 0) color = mix(color, [255, 255, 255], clamp01(-glow * 0.7) * 0.30);
  const star = sparkle(x, y, 0.205);
  if (star < 0) color = mix(color, [255, 255, 255], clamp01(-star * 9));

  // Kante weich auslaufen lassen
  const alpha = clamp01((0.004 - body) / 0.006) * 255;
  return [color[0], color[1], color[2], alpha];
}

/** Rendert mit 3x3-Überabtastung, damit Rundungen sauber aussehen. */
function render(size) {
  const ss = 3;
  const data = Buffer.alloc(size * size * 4);
  for (let py = 0; py < size; py++) {
    for (let px = 0; px < size; px++) {
      let r = 0, g = 0, b = 0, a = 0;
      for (let sy = 0; sy < ss; sy++) {
        for (let sx = 0; sx < ss; sx++) {
          const x = (px + (sx + 0.5) / ss) / size - 0.5;
          const y = (py + (sy + 0.5) / ss) / size - 0.5;
          const c = shade(x, y);
          if (c) { r += c[0] * c[3]; g += c[1] * c[3]; b += c[2] * c[3]; a += c[3]; }
        }
      }
      const i = (py * size + px) * 4;
      if (a > 0) {
        data[i] = Math.round(r / a);
        data[i + 1] = Math.round(g / a);
        data[i + 2] = Math.round(b / a);
        data[i + 3] = Math.round(a / (ss * ss));
      }
    }
  }
  return data;
}

/* ── PNG schreiben ────────────────────────────────────────────── */

function crc32(buf) {
  let c = ~0;
  for (const byte of buf) {
    c ^= byte;
    for (let k = 0; k < 8; k++) c = (c >>> 1) ^ (0xedb88320 & -(c & 1));
  }
  return ~c >>> 0;
}

function chunk(type, body) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(body.length);
  const typed = Buffer.concat([Buffer.from(type, 'ascii'), body]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(typed));
  return Buffer.concat([len, typed, crc]);
}

function toPng(rgba, size) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8;    // 8 Bit pro Kanal
  ihdr[9] = 6;    // RGBA
  // Jede Zeile bekommt ein Filter-Byte (0 = kein Filter)
  const raw = Buffer.alloc(size * (size * 4 + 1));
  for (let y = 0; y < size; y++) {
    raw[y * (size * 4 + 1)] = 0;
    rgba.copy(raw, y * (size * 4 + 1) + 1, y * size * 4, (y + 1) * size * 4);
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

/* ── ICO für Windows ──────────────────────────────────────────── */

function toIco(pngs) {
  const header = Buffer.alloc(6);
  header.writeUInt16LE(0, 0);
  header.writeUInt16LE(1, 2);
  header.writeUInt16LE(pngs.length, 4);
  let offset = 6 + pngs.length * 16;
  const entries = [];
  for (const { size, png } of pngs) {
    const e = Buffer.alloc(16);
    e[0] = size >= 256 ? 0 : size;
    e[1] = size >= 256 ? 0 : size;
    e.writeUInt16LE(1, 4);
    e.writeUInt16LE(32, 6);
    e.writeUInt32LE(png.length, 8);
    e.writeUInt32LE(offset, 12);
    entries.push(e);
    offset += png.length;
  }
  return Buffer.concat([header, ...entries, ...pngs.map((p) => p.png)]);
}

/* ── Los ──────────────────────────────────────────────────────── */

console.log('Zeichne Icons…');
const sizes = [16, 32, 64, 128, 256, 512, 1024];
const pngs = new Map();
for (const size of sizes) {
  pngs.set(size, toPng(render(size), size));
  process.stdout.write(`  ${size}px\n`);
}

fs.writeFileSync(path.join(outDir, 'icon.png'), pngs.get(1024));

// .icns über iconutil (gehört zu macOS)
if (process.platform === 'darwin') {
  const iconset = path.join(outDir, 'icon.iconset');
  fs.rmSync(iconset, { recursive: true, force: true });
  fs.mkdirSync(iconset);
  const map = [
    [16, 'icon_16x16.png'], [32, 'icon_16x16@2x.png'],
    [32, 'icon_32x32.png'], [64, 'icon_32x32@2x.png'],
    [128, 'icon_128x128.png'], [256, 'icon_128x128@2x.png'],
    [256, 'icon_256x256.png'], [512, 'icon_256x256@2x.png'],
    [512, 'icon_512x512.png'], [1024, 'icon_512x512@2x.png'],
  ];
  for (const [size, name] of map) fs.writeFileSync(path.join(iconset, name), pngs.get(size));
  execFileSync('iconutil', ['-c', 'icns', iconset, '-o', path.join(outDir, 'icon.icns')]);
  fs.rmSync(iconset, { recursive: true, force: true });
  console.log('  icon.icns');
}

fs.writeFileSync(path.join(outDir, 'icon.ico'), toIco(
  [16, 32, 64, 128, 256].map((size) => ({ size, png: pngs.get(size) })),
));
console.log('  icon.ico');

for (const f of ['icon.png', 'icon.icns', 'icon.ico']) {
  const p = path.join(outDir, f);
  if (fs.existsSync(p)) console.log(`  ${f}: ${(fs.statSync(p).size / 1024).toFixed(0)} KB`);
}
