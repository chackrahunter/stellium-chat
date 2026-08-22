import { useEffect, useRef, useState } from 'react';
import {
  Activity, AlertTriangle, Cpu, Gauge as GaugeIcon, Globe, HardDrive,
  Loader2, MemoryStick, Server, Thermometer,
} from 'lucide-react';
import { Shell } from './Panels.jsx';
import { useT } from '../i18n';
import { api } from '../net/api.js';

/**
 * Die Werte des Servers — dieselben, die die Konsole auf dem Pi zeigt.
 *
 * Die Tachos sind kein Zierrat: Auslastung, Speicher und Temperatur haben
 * alle eine Obergrenze, und ein Tacho zeigt den Abstand dazu auf einen Blick.
 * Eine Zahl allein tut das nicht — „55 Grad" sagt ohne den Bogen nichts
 * darüber, ob das viel ist.
 */

/* ── Tacho ─────────────────────────────────────────────────────
   Ein Bogen von 270 Grad, unten offen. Von Hand gezeichnet, weil eine
   Bibliothek dafür mehr wöge als die ganze Tafel. */
function Tacho({ anteil, wert, name, warnAb = 0.8 }: {
  anteil: number; wert: string; name: string; warnAb?: number;
}) {
  const a = Math.max(0, Math.min(1, anteil));
  const r = 34;                       /* Radius im Koordinatensystem */
  const umfang = 2 * Math.PI * r;
  const bogen = 0.75;                 /* 270 Grad von 360 */
  const farbe = a >= 0.92 ? 'var(--red)' : a >= warnAb ? 'var(--amber)' : 'var(--cyan)';
  return (
    <div className="tacho">
      <svg viewBox="0 0 88 88" className="tacho__svg">
        {/* Gedreht, damit die Lücke unten liegt und nicht rechts. */}
        <g transform="rotate(135 44 44)">
          <circle cx="44" cy="44" r={r} fill="none" stroke="var(--line)" strokeWidth="7"
                  strokeLinecap="round" strokeDasharray={`${umfang * bogen} ${umfang}`} />
          <circle cx="44" cy="44" r={r} fill="none" stroke={farbe} strokeWidth="7"
                  strokeLinecap="round" strokeDasharray={`${umfang * bogen * a} ${umfang}`} />
        </g>
        <text x="44" y="46" className="tacho__zahl" textAnchor="middle">{wert}</text>
      </svg>
      <div className="tacho__name">{name}</div>
    </div>
  );
}

function Zeile({ name, wert, ton }: { name: string; wert: React.ReactNode; ton?: 'gut' | 'warn' }) {
  return (
    <div className="syszeile">
      <span className="syszeile__name">{name}</span>
      <span className={`syszeile__wert ${ton ? `syszeile__wert--${ton}` : ''}`}>{wert}</span>
    </div>
  );
}

/* "9,2 GB" statt "9873154" */
function groesse(bytes: number): string {
  const e = ['B', 'KB', 'MB', 'GB', 'TB'];
  let i = 0; let v = bytes;
  while (v >= 1024 && i < e.length - 1) { v /= 1024; i++; }
  return `${v.toFixed(v < 10 && i > 0 ? 1 : 0)} ${e[i]}`;
}

function laufzeit(sek: number): string {
  const t = Math.floor(sek / 86400);
  const h = Math.floor((sek % 86400) / 3600);
  return t > 0 ? `${t} d ${h} h` : `${h} h ${Math.floor((sek % 3600) / 60)} min`;
}

type Werte = Record<string, any>;

export function SystemPanel({ onClose }: { onClose: () => void }) {
  const t = useT();
  const [daten, setDaten] = useState<Werte | null>(null);
  const [fehler, setFehler] = useState<string | null>(null);
  const [da, setDa] = useState(true);
  const laeuft = useRef(true);

  useEffect(() => {
    laeuft.current = true;
    const holen = () => {
      api.system()
        .then((a) => {
          if (!laeuft.current) return;
          setDa(a.da);
          if (a.werte) setDaten(a.werte as Werte);
          setFehler(null);
        })
        .catch((f: Error) => { if (laeuft.current) setFehler(f.message); });
    };
    holen();
    /* Vier Sekunden — genauso oft, wie der Server die Werte neu misst.
       Häufiger zu fragen brächte dieselben Zahlen zurück. */
    const takt = window.setInterval(holen, 4000);
    return () => { laeuft.current = false; window.clearInterval(takt); };
  }, []);

  const inhalt = () => {
    if (fehler) return <div className="sys__leer"><AlertTriangle size={15} /> {fehler}</div>;
    if (!da) return <div className="sys__leer">{t('system.nichtDa')}</div>;
    if (!daten) return <div className="sys__leer"><Loader2 size={16} className="dreht" /></div>;

    /* Die Namen stammen aus `stellium-konsole.mjs json` und sind gegen die
       echte Ausgabe geprüft, nicht geraten: der Block heisst `leistung`, die
       CPU-Last ist ein ANTEIL von 0 bis 1 (nicht Prozent), der
       Arbeitsspeicher liegt flach als ramAnteil/ramBelegt/ramGesamt, und die
       Temperatur steht als [{ name, grad }]. */
    const l = daten.leistung ?? {};
    const temp: number | null = Array.isArray(l.temperaturen) && l.temperaturen.length
      ? Number(l.temperaturen[0]?.grad) : null;
    const pl = l.platte ?? {};
    const ab = daten.ablage ?? {};
    const w = daten.webseite ?? {};

    return (
      <div className="sys">
        <div className="sys__tachos">
          <Tacho name={t('system.cpu')} anteil={l.cpu ?? 0} wert={`${Math.round((l.cpu ?? 0) * 100)}%`} />
          <Tacho name={t('system.ram')} anteil={l.ramAnteil ?? 0}
                 wert={`${Math.round((l.ramAnteil ?? 0) * 100)}%`} />
          <Tacho name={t('system.platte')} anteil={(pl.belegt ?? 0) / (pl.gesamt || 1)}
                 wert={`${Math.round(((pl.belegt ?? 0) / (pl.gesamt || 1)) * 100)}%`} />
          <Tacho name={t('system.ablage')} anteil={(ab.belegt ?? 0) / (ab.gesamt || 1)}
                 wert={`${Math.round(((ab.belegt ?? 0) / (ab.gesamt || 1)) * 100)}%`} />
          {temp !== null && (
            /* 85 Grad ist die Grenze, ab der ein Pi drosselt — deshalb ist
               das der Maßstab und nicht 100. */
            <Tacho name={t('system.temperatur')} anteil={temp / 85} wert={`${Math.round(temp)}°`} warnAb={0.82} />
          )}
        </div>

        <div className="sys__spalten">
          <section className="sys__block">
            <h3 className="sys__titel"><Server size={14} /> {t('system.dienste')}</h3>
            <Zeile name={t('system.chatserver')} ton={daten.dienste?.chat?.an ? 'gut' : 'warn'}
                   wert={daten.dienste?.chat?.an ? t('system.laeuft') : t('system.aus')} />
            <Zeile name={t('system.webserver')} ton={daten.dienste?.web?.an ? 'gut' : 'warn'}
                   wert={daten.dienste?.web?.an ? t('system.laeuft') : t('system.aus')} />
            <Zeile name={t('system.tunnel')} ton={daten.dienste?.tunnel ? 'gut' : 'warn'}
                   wert={daten.dienste?.tunnel ? t('system.laeuft') : t('system.aus')} />
            <Zeile name={t('system.version')} wert={daten.version ?? '—'} />
            <Zeile name={t('system.laufzeit')} wert={laufzeit(l.laufzeit ?? 0)} />
          </section>

          <section className="sys__block">
            <h3 className="sys__titel"><Activity size={14} /> {t('system.chat')}</h3>
            <Zeile name={t('system.verbunden')}
                   wert={`${daten.verbunden?.clients ?? 0} · ${daten.verbunden?.benutzer ?? 0}`} />
            <Zeile name={t('system.konten')} wert={daten.inhalt?.users ?? 0} />
            <Zeile name={t('system.kanaele')} wert={daten.inhalt?.channels ?? 0} />
            <Zeile name={t('system.nachrichten')} wert={daten.inhalt?.messages ?? 0} />
            <Zeile name={t('system.datenbank')} wert={groesse(daten.inhalt?.groesse ?? 0)} />
            <Zeile name={t('system.dateien')} wert={`${daten.ablage?.dateien ?? 0} · ${groesse(ab.belegt ?? 0)}`} />
          </section>

          {w?.da && (
            <section className="sys__block">
              <h3 className="sys__titel"><Globe size={14} /> {t('system.webseite')}</h3>
              <Zeile name={t('system.jetzt')} wert={w.jetzt ?? 0} />
              <Zeile name={t('system.heute')}
                     wert={`${w.heute?.besucher ?? 0} · ${w.heute?.seiten ?? 0}`} />
              <Zeile name={t('system.woche')}
                     wert={`${w.woche?.besucher ?? 0} · ${w.woche?.seiten ?? 0}`} />
              <Zeile name={t('system.fehler404')} wert={w.heute?.f404 ?? 0} />
              <Zeile name={t('system.fehler5xx')} ton={(w.heute?.f5xx ?? 0) > 0 ? 'warn' : undefined}
                     wert={w.heute?.f5xx ?? 0} />
              <Zeile name={t('system.uebertragen')} wert={groesse(w.heute?.bytes ?? 0)} />
            </section>
          )}

          <section className="sys__block">
            <h3 className="sys__titel"><HardDrive size={14} /> {t('system.netz')}</h3>
            <Zeile name={t('system.empfangen')} wert={groesse(l.netz?.rein ?? 0)} />
            <Zeile name={t('system.gesendet')} wert={groesse(l.netz?.raus ?? 0)} />
            <Zeile name={t('system.sicherungen')}
                   wert={daten.sicherung ? `${daten.sicherung.anzahl}` : '—'} />
            {Array.isArray(daten.bestandteile) && daten.bestandteile.slice(0, 4).map((b: any) => (
              <Zeile key={b.name} name={b.name} wert={b.fassung ?? '—'} />
            ))}
          </section>
        </div>
      </div>
    );
  };

  return (
    <Shell title={t('system.titel')} icon={<GaugeIcon size={16} />} onClose={onClose} width={860}>
      {inhalt()}
    </Shell>
  );
}
