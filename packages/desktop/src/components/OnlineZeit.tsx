import { useEffect, useMemo, useState } from 'react';
import { Loader2 } from 'lucide-react';
import { useT } from '../i18n';
import { api } from '../net/api.js';

/**
 * Wie lange jemand online war — als Linie über die Zeit.
 *
 * Linie und nicht Balken, und das ist kein Geschmack: Balken vergleichen
 * einzelne Tage miteinander, eine Linie zeigt den VERLAUF. Bei 365 Werten
 * wären Balken ohnehin Striche von einem Bildpunkt Breite.
 *
 * Gezeichnet von Hand statt mit einer Diagrammbibliothek. Eine Linie, eine
 * Fläche darunter und ein paar Beschriftungen sind vierzig Zeilen; die
 * kleinste Bibliothek dafür wiegt ein Vielfaches der ganzen Oberfläche und
 * bringt ihre eigenen Farben mit, die dann doch wieder übersteuert werden
 * müssen.
 */

type Zeitraum = 'heute' | 'woche' | 'monat' | 'jahr';

/** "2 h 14 min" statt "8040 s" — das liest sich nebenbei. */
function dauer(sekunden: number, t: (k: never) => string): string {
  if (sekunden < 60) return `0 ${t('onlinezeit.min' as never)}`;
  const min = Math.round(sekunden / 60);
  if (min < 60) return `${min} ${t('onlinezeit.min' as never)}`;
  const std = Math.floor(min / 60);
  const rest = min % 60;
  if (std < 24) return rest ? `${std} ${t('onlinezeit.std' as never)} ${rest} ${t('onlinezeit.min' as never)}` : `${std} ${t('onlinezeit.std' as never)}`;
  const tage = Math.floor(std / 24);
  return `${tage} ${t('onlinezeit.tage' as never)} ${std % 24} ${t('onlinezeit.std' as never)}`;
}

function Linie({ werte, beschriftung }: {
  werte: { tag: string; sekunden: number }[];
  beschriftung: string;
}) {
  const { pfad, flaeche, hoehe, breite } = useMemo(() => {
    const b = 100, h = 34;                         /* im Koordinatensystem des SVG */
    const max = Math.max(60, ...werte.map((w) => w.sekunden));
    const n = Math.max(1, werte.length - 1);
    const punkte = werte.map((w, i) => {
      const x = (i / n) * b;
      /* 2 Punkte Luft oben, damit die Spitze nicht am Rand klebt. */
      const y = h - 2 - (w.sekunden / max) * (h - 4);
      return `${x.toFixed(2)},${y.toFixed(2)}`;
    });
    return {
      pfad: 'M' + punkte.join(' L'),
      flaeche: `M0,${h} L` + punkte.join(' L') + ` L${b},${h} Z`,
      hoehe: h, breite: b,
    };
  }, [werte]);

  return (
    <svg className="onlinezeit__linie" viewBox={`0 0 ${breite} ${hoehe}`} preserveAspectRatio="none"
         role="img" aria-label={beschriftung}>
      <defs>
        <linearGradient id="onlinezeit-fuellung" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor="var(--violet)" stopOpacity="0.28" />
          <stop offset="100%" stopColor="var(--violet)" stopOpacity="0" />
        </linearGradient>
      </defs>
      <path d={flaeche} fill="url(#onlinezeit-fuellung)" />
      {/* vectorEffect: ohne das zieht preserveAspectRatio="none" die Linie
          waagerecht mit in die Breite und sie wird ungleichmäßig dick. */}
      <path d={pfad} fill="none" stroke="var(--violet)" strokeWidth="1.2"
            strokeLinejoin="round" strokeLinecap="round" vectorEffect="non-scaling-stroke" />
    </svg>
  );
}

export function OnlineZeit({ userId }: { userId: string }) {
  const t = useT();
  const [zeitraum, setZeitraum] = useState<Zeitraum>('woche');
  const [daten, setDaten] = useState<Awaited<ReturnType<typeof api.praesenz>> | null>(null);
  const [fehler, setFehler] = useState<string | null>(null);
  /* Kein Recht auf diese Zahlen — dann gar nichts zeigen. */
  const [verdeckt, setVerdeckt] = useState(false);
  const [laedt, setLaedt] = useState(true);

  useEffect(() => {
    let weg = false;
    setLaedt(true);
    api.praesenz(userId, zeitraum)
      .then((d) => { if (!weg) { setDaten(d); setFehler(null); } })
      .catch((f: Error) => {
        if (weg) return;
        /*
         * Ein fehlendes Recht ist kein Fehler.
         *
         * Diese Anzeige steht in JEDER Kontokarte. Die eigene Zeit darf jeder
         * sehen, die von anderen nur, wer Konten verwaltet — bei allen anderen
         * antwortet der Server mit 403. Das als roten Kasten zu zeigen hiesse:
         * in jeder fremden Kontokarte steht eine Fehlermeldung, obwohl alles
         * richtig läuft. Dann verschwindet der Block einfach.
         */
        /* Am Statuscode und nicht am Text: die Meldung ist übersetzt, „403"
           steht dort in keiner der 22 Sprachen. */
        if ((f as { status?: number }).status === 403) { setVerdeckt(true); return; }
        setFehler(f.message);
      })
      .finally(() => { if (!weg) setLaedt(false); });
    return () => { weg = true; };
  }, [userId, zeitraum]);

  if (verdeckt) return null;
  if (fehler) return <div className="onlinezeit__leer">{fehler}</div>;

  const zeitraeume: Zeitraum[] = ['heute', 'woche', 'monat', 'jahr'];

  return (
    <div className="onlinezeit">
      <div className="onlinezeit__kopf">
        <span className="onlinezeit__titel">{t('onlinezeit.titel')}</span>
        <span className="spacer" />
        <div className="onlinezeit__waehler">
          {zeitraeume.map((z) => (
            <button
              key={z}
              type="button"
              className={`onlinezeit__tab ${z === zeitraum ? 'onlinezeit__tab--an' : ''}`}
              onClick={() => setZeitraum(z)}
            >
              {t(`onlinezeit.${z}` as never)}
            </button>
          ))}
        </div>
      </div>

      <div className="onlinezeit__wert">
        {laedt && !daten
          ? <Loader2 size={16} className="dreht" />
          : dauer(daten?.summen[zeitraum] ?? 0, t as never)}
      </div>

      {/* Bei „heute" ist ein Verlauf aus einem einzigen Punkt keine Linie —
          dann steht die Zahl für sich. */}
      {daten && daten.verlauf.length > 1 && (
        <Linie
          werte={daten.verlauf}
          /* Für Vorlesehilfen: eine Linie ohne Beschriftung ist für sie
             stumm. Kein fester Text — die Oberfläche spricht 22 Sprachen. */
          beschriftung={`${t('onlinezeit.titel')}: ${dauer(daten.summen[zeitraum] ?? 0, t as never)}`}
        />
      )}

      {daten && daten.verlauf.length > 1 && (
        <div className="onlinezeit__achse">
          <span>{daten.verlauf[0].tag.slice(5)}</span>
          <span>{daten.verlauf[daten.verlauf.length - 1].tag.slice(5)}</span>
        </div>
      )}
    </div>
  );
}
