import { useEffect, useRef, useState } from 'react';
import { hintergrundBeobachten, hintergrundLesen } from '../lib/hintergrund.js';

/**
 * Hintergrund: driftende Nebel plus ein leicht funkelndes Sternenfeld.
 * Der Canvas zeichnet nur bei Größenänderung neu und animiert das Funkeln
 * mit sehr wenig Aufwand — nichts davon soll das Tippen ausbremsen.
 *
 * Die Stufe ("kosmos", "still", "aus") wählt die Person im Einstellungen-
 * Reiter Darstellung (lib/hintergrund.ts). "Aus" zeichnet hier gar nichts
 * mehr; bei "still" übernimmt das Stylesheet das Abschalten von Sternen und
 * Bewegung, und der Animationslauf unten bleibt gleich ganz weg — ein
 * requestAnimationFrame pro Bild ist verschwendete Batterie, wenn niemand
 * funkelt.
 */
export function Cosmos() {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [stufe, setStufe] = useState(hintergrundLesen);

  useEffect(() => hintergrundBeobachten(setStufe), []);

  useEffect(() => {
    if (stufe === 'aus') return undefined;
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    const reduced = stufe === 'still'
      || window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    let stars: { x: number; y: number; r: number; base: number; speed: number; phase: number }[] = [];
    let raf = 0;
    let width = 0;
    let height = 0;

    const build = () => {
      const dpr = Math.min(window.devicePixelRatio || 1, 2);
      width = canvas.clientWidth;
      height = canvas.clientHeight;
      canvas.width = Math.floor(width * dpr);
      canvas.height = Math.floor(height * dpr);
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

      const count = Math.min(230, Math.round((width * height) / 9000));
      stars = Array.from({ length: count }, () => ({
        x: Math.random() * width,
        y: Math.random() * height,
        r: Math.random() * 1.15 + 0.35,
        base: Math.random() * 0.45 + 0.2,
        speed: Math.random() * 0.0011 + 0.0004,
        phase: Math.random() * Math.PI * 2,
      }));
    };

    const draw = (t: number) => {
      ctx.clearRect(0, 0, width, height);
      for (const s of stars) {
        const twinkle = reduced ? s.base : s.base + Math.sin(t * s.speed + s.phase) * 0.28;
        ctx.globalAlpha = Math.max(0.05, Math.min(1, twinkle));
        ctx.beginPath();
        ctx.arc(s.x, s.y, s.r, 0, Math.PI * 2);
        ctx.fillStyle = s.r > 1.1 ? '#a9b6ff' : '#ffffff';
        ctx.fill();
      }
      ctx.globalAlpha = 1;
      if (!reduced) raf = requestAnimationFrame(draw);
    };

    build();
    draw(0);

    const onResize = () => { build(); if (reduced) draw(0); };
    window.addEventListener('resize', onResize);
    return () => {
      window.removeEventListener('resize', onResize);
      cancelAnimationFrame(raf);
    };
  }, [stufe]);

  /* "Aus" heißt aus: kein Canvas, keine Nebelflecken — nur die flächige
     Farbe des Themas. Das Attribut am Wurzelelement regelt den Rest. */
  if (stufe === 'aus') return null;

  return (
    <div className="cosmos" aria-hidden="true">
      <canvas ref={canvasRef} className="cosmos__stars" />
      <div className="cosmos__blob cosmos__blob--a" />
      <div className="cosmos__blob cosmos__blob--b" />
      <div className="cosmos__blob cosmos__blob--c" />
    </div>
  );
}
