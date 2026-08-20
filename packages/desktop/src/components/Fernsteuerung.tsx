/**
 * Der Pi-Schreibtisch im Fenster.
 *
 * Dekodiert wird mit `VideoDecoder` aus den WebCodecs. Auf einem Mac läuft
 * das über VideoToolbox — also in Hardware, mit fast keiner Prozessorlast.
 * Das ist der Grund, warum hier H.264 ankommt und keine fertigen Bildpunkte:
 * ein Bild in 1280x720 wäre als RGBA 3,7 MB, als H.264 sind es ein paar
 * Kilobyte.
 *
 * `optimizeForLatency` sagt dem Dekodierer, dass er jedes Bild sofort
 * herausgeben soll, statt erst ein paar zu sammeln. Ohne das kämen die
 * Bilder in Schüben, und genau das fühlt sich hakelig an — auch wenn am Ende
 * dieselbe Zahl Bilder ankommt.
 */
import { useEffect, useRef, useState, useCallback } from 'react';
import { Monitor, Power, Loader2, AlertTriangle, Keyboard } from 'lucide-react';
import { Shell } from './Panels.jsx';
import { t } from '../i18n';
import '../styles/fernsteuerung.css';

/* Linux kennt Tasten als evdev-Nummern, der Browser als Namen. Diese
   Zuordnung ist der Übersetzer dazwischen. */
const TASTEN: Record<string, number> = {
  Escape: 1, Digit1: 2, Digit2: 3, Digit3: 4, Digit4: 5, Digit5: 6, Digit6: 7,
  Digit7: 8, Digit8: 9, Digit9: 10, Digit0: 11, Minus: 12, Equal: 13,
  Backspace: 14, Tab: 15,
  KeyQ: 16, KeyW: 17, KeyE: 18, KeyR: 19, KeyT: 20, KeyY: 21, KeyU: 22,
  KeyI: 23, KeyO: 24, KeyP: 25, BracketLeft: 26, BracketRight: 27, Enter: 28,
  ControlLeft: 29,
  KeyA: 30, KeyS: 31, KeyD: 32, KeyF: 33, KeyG: 34, KeyH: 35, KeyJ: 36,
  KeyK: 37, KeyL: 38, Semicolon: 39, Quote: 40, Backquote: 41, ShiftLeft: 42,
  Backslash: 43,
  KeyZ: 44, KeyX: 45, KeyC: 46, KeyV: 47, KeyB: 48, KeyN: 49, KeyM: 50,
  Comma: 51, Period: 52, Slash: 53, ShiftRight: 54, NumpadMultiply: 55,
  AltLeft: 56, Space: 57, CapsLock: 58,
  F1: 59, F2: 60, F3: 61, F4: 62, F5: 63, F6: 64, F7: 65, F8: 66, F9: 67,
  F10: 68, NumLock: 69, ScrollLock: 70, F11: 87, F12: 88,
  ControlRight: 97, NumpadDivide: 98, AltRight: 100,
  Home: 102, ArrowUp: 103, PageUp: 104, ArrowLeft: 105, ArrowRight: 106,
  End: 107, ArrowDown: 108, PageDown: 109, Insert: 110, Delete: 111,
  /* Die Befehlstaste des Macs wird zu Strg. Auf einem Linux-Schreibtisch
     liegt dort alles, was man auf dem Mac mit ⌘ macht — Kopieren, Einfügen,
     Suchen. Auf Super abzubilden wäre wörtlicher, aber im Alltag falsch. */
  MetaLeft: 29, MetaRight: 97,
};

const KNOPF: Record<number, number> = { 0: 272, 1: 274, 2: 273 };  /* links, mitte, rechts */

type Lage = 'getrennt' | 'verbindet' | 'meldet an' | 'offen' | 'fehler';

export function Fernsteuerung({ onClose }: { onClose: () => void }) {
  const leinwand = useRef<HTMLCanvasElement>(null);
  const dekoder = useRef<VideoDecoder | null>(null);
  const zeitmarke = useRef(0);
  const wartetSchluesselbild = useRef(true);
  const feldRef = useRef<HTMLDivElement>(null);

  const [lage, setLage] = useState<Lage>('getrennt');
  const [fehler, setFehler] = useState('');
  const [adresse, setAdresse] = useState(() => localStorage.getItem('fern.adresse') ?? '');
  const [passwort, setPasswort] = useState('');
  const [info, setInfo] = useState<{ takt?: string; verworfen?: number } | null>(null);
  const [steuert, setSteuert] = useState(false);

  const fern = (window as any).stellium?.fern;

  /* ── Dekodieren ────────────────────────────────────────────── */

  const dekoderRichten = useCallback(() => {
    if (dekoder.current) { try { dekoder.current.close(); } catch { /* schon zu */ } }
    const d = new VideoDecoder({
      output: (bild) => {
        const c = leinwand.current;
        if (!c) { bild.close(); return; }
        if (c.width !== bild.displayWidth || c.height !== bild.displayHeight) {
          c.width = bild.displayWidth;
          c.height = bild.displayHeight;
        }
        const ctx = c.getContext('2d');
        ctx?.drawImage(bild, 0, 0);
        /* Muss sein: ein VideoFrame hält Speicher außerhalb des Müllsammlers.
           Wer das vergisst, bekommt nach ein paar hundert Bildern einen
           Dekodierer, der stehenbleibt. */
        bild.close();
      },
      error: (f) => setFehler(String(f)),
    });
    /* Constrained Baseline, Stufe 3.1 — dasselbe, was der Pi kodiert.
       Ohne `description` versteht der Dekodierer den Strom als Annex-B,
       und genau so schickt ihn x264 mit `b_annexb`. */
    d.configure({ codec: 'avc1.42E01F', optimizeForLatency: true, hardwareAcceleration: 'prefer-hardware' });
    dekoder.current = d;
    wartetSchluesselbild.current = true;
    zeitmarke.current = 0;
  }, []);

  useEffect(() => {
    if (!fern) return;
    const abBild = fern.aufBild((daten: Uint8Array) => {
      const d = dekoder.current;
      if (!d || d.state !== 'configured') return;
      const schluessel = istSchluesselbild(daten);
      /* Nach einem Neustart oder Bildaussetzer erst wieder einsteigen, wenn
         ein vollständiges Bild kommt — ein Zwischenbild ohne seinen Bezug
         ergibt nur Grün und Schlieren. */
      if (wartetSchluesselbild.current) {
        if (!schluessel) return;
        wartetSchluesselbild.current = false;
      }
      try {
        d.decode(new EncodedVideoChunk({
          type: schluessel ? 'key' : 'delta',
          timestamp: zeitmarke.current,
          data: daten,
        }));
        zeitmarke.current += 33333;
      } catch {
        wartetSchluesselbild.current = true;
      }
    });
    const abZustand = fern.aufZustand((z: { lage: Lage; fehler: string }) => {
      setLage(z.lage);
      setFehler(z.fehler);
      if (z.lage === 'offen') dekoderRichten();
      if (z.lage !== 'offen') { setSteuert(false); setInfo(null); }
    });
    const abInfo = fern.aufInfo((i: any) => setInfo(i));
    void fern.lage().then((z: { lage: Lage; fehler: string }) => {
      setLage(z.lage); setFehler(z.fehler);
    });
    return () => { abBild?.(); abZustand?.(); abInfo?.(); };
  }, [fern, dekoderRichten]);

  useEffect(() => () => { try { dekoder.current?.close(); } catch { /* egal */ } }, []);

  /* ── Eingaben ──────────────────────────────────────────────── */

  /** Wo auf dem Pi-Schirm liegt dieser Mausklick? Die Leinwand ist meist
   *  kleiner als das Bild und hat Ränder — beides muss herausgerechnet
   *  werden, sonst wandert der Zeiger mit wachsendem Abstand vom Rand
   *  immer weiter weg. */
  const nachSchirm = (e: React.MouseEvent): [number, number] | null => {
    const c = leinwand.current;
    if (!c || !c.width) return null;
    const r = c.getBoundingClientRect();
    const x = (e.clientX - r.left) / r.width;
    const y = (e.clientY - r.top) / r.height;
    if (x < 0 || x > 1 || y < 0 || y > 1) return null;
    return [Math.round(x * 65535), Math.round(y * 65535)];
  };

  const schick = (zeile: string) => { if (steuert) fern?.eingabe(zeile); };

  const beiBewegung = (e: React.MouseEvent) => {
    const p = nachSchirm(e);
    if (p) schick(`z ${p[0]} ${p[1]}\n`);
  };
  const beiKnopf = (e: React.MouseEvent, ab: boolean) => {
    const p = nachSchirm(e);
    const k = KNOPF[e.button];
    if (!p || !k) return;
    e.preventDefault();
    /* Erst hinbewegen, dann klicken — sonst klickt es dort, wo der Zeiger
       zuletzt war. */
    schick(`z ${p[0]} ${p[1]}\nt ${k} ${ab ? 1 : 0}\n`);
  };
  const beiRad = (e: React.WheelEvent) => {
    if (!steuert) return;
    /* Wayland zählt Rollen in derselben Einheit wie eine Maus mit Rasten:
       15 je Raste. Die Zeilen des Browsers werden hier darauf umgerechnet. */
    const senkrecht = e.deltaY / 100 * 15;
    const waagerecht = e.deltaX / 100 * 15;
    if (senkrecht) schick(`r 0 ${senkrecht.toFixed(2)}\n`);
    if (waagerecht) schick(`r 1 ${waagerecht.toFixed(2)}\n`);
  };

  useEffect(() => {
    if (!steuert) return;
    const runter = (e: KeyboardEvent) => {
      const code = TASTEN[e.code];
      if (code === undefined) return;
      e.preventDefault();
      fern?.eingabe(`k ${code} 1\n`);
    };
    const hoch = (e: KeyboardEvent) => {
      const code = TASTEN[e.code];
      if (code === undefined) return;
      e.preventDefault();
      fern?.eingabe(`k ${code} 0\n`);
    };
    window.addEventListener('keydown', runter, true);
    window.addEventListener('keyup', hoch, true);
    return () => {
      window.removeEventListener('keydown', runter, true);
      window.removeEventListener('keyup', hoch, true);
    };
  }, [steuert, fern]);

  /* ── Ansicht ───────────────────────────────────────────────── */

  const verbinden = () => {
    if (!adresse.trim() || !passwort) return;
    localStorage.setItem('fern.adresse', adresse.trim());
    void fern?.verbinden(adresse.trim(), passwort);
    setPasswort('');            /* nicht im Formular stehen lassen */
  };

  if (!fern) {
    return (
      <Shell title={t('fern.titel')} icon={<Monitor size={16} />} onClose={onClose} width={520}>
        <div className="fern__leer">
          <Monitor size={32} />
          <p>{t('fern.nurApp')}</p>
        </div>
      </Shell>
    );
  }

  const werkzeuge = lage === 'offen' ? (
    <>
      <button
        type="button"
        className={`fern__knopf ${steuert ? 'fern__knopf--an' : ''}`}
        onClick={() => setSteuert((s) => !s)}
        title={t('fern.steuernHilfe')}
      >
        <Keyboard size={14} />
        {steuert ? t('fern.steuertAn') : t('fern.steuertAus')}
      </button>
      <button type="button" className="fern__knopf" onClick={() => void fern.trennen()}>
        <Power size={14} /> {t('fern.trennen')}
      </button>
    </>
  ) : (
    <form className="fern__anmeldung" onSubmit={(e) => { e.preventDefault(); verbinden(); }}>
      <input
        type="text" value={adresse} onChange={(e) => setAdresse(e.target.value)}
        placeholder="ws://…:7788" spellCheck={false} autoComplete="off"
      />
      <input
        type="password" value={passwort} onChange={(e) => setPasswort(e.target.value)}
        placeholder={t('fern.passwort')} autoComplete="off"
      />
      <button type="submit" disabled={lage === 'verbindet' || lage === 'meldet an'}>
        {lage === 'verbindet' || lage === 'meldet an'
          ? <Loader2 size={14} className="dreht" />
          : t('fern.verbinden')}
      </button>
    </form>
  );

  return (
    <Shell
      title={t('fern.titel')}
      icon={<Monitor size={16} />}
      onClose={onClose}
      width={1180}
      subtitle={lage === 'offen' ? info?.takt : undefined}
      actions={werkzeuge}
    >
      <div className="fern" ref={feldRef}>
        {fehler && (
          <div className="fern__fehler">
            <AlertTriangle size={14} /> {fehler}
          </div>
        )}
        <div className="fern__buehne">
          <canvas
            ref={leinwand}
            className={`fern__schirm ${steuert ? 'fern__schirm--steuert' : ''}`}
            onMouseMove={beiBewegung}
            onMouseDown={(e) => beiKnopf(e, true)}
            onMouseUp={(e) => beiKnopf(e, false)}
            onWheel={beiRad}
            onContextMenu={(e) => e.preventDefault()}
          />
          {lage !== 'offen' && (
            <div className="fern__hinweis">
              {lage === 'verbindet' || lage === 'meldet an'
                ? t('fern.verbindet')
                : t('fern.nichtVerbunden')}
            </div>
          )}
        </div>
      </div>
    </Shell>
  );
}

/** Fängt dieses Häppchen mit einem vollständigen Bild an? In Annex-B steht
 *  vor jedem Stück ein Startzeichen; die fünf unteren Bits des Bytes danach
 *  sagen, was folgt — 7 ist der Bildkopf (SPS), 5 ein vollständiges Bild. */
function istSchluesselbild(daten: Uint8Array): boolean {
  for (let i = 0; i + 4 < daten.length && i < 64; i++) {
    if (daten[i] === 0 && daten[i + 1] === 0 && daten[i + 2] === 1) {
      const art = daten[i + 3] & 0x1f;
      if (art === 7 || art === 5) return true;
      if (art === 1) return false;
    }
  }
  return false;
}
