import { useEffect, useRef, useState } from 'react';
import {
  Activity, AlertTriangle, ChevronRight, Cpu, Gauge as GaugeIcon, Globe, HardDrive,
  Loader2, MemoryStick, Server, Thermometer, Wallet,
} from 'lucide-react';
import { Shell } from './Panels.jsx';
import { VerkaufDetailPanel } from './VerkaufDetailPanel.jsx';
import { useT, currentUiLanguage } from '../i18n';
import { api } from '../net/api.js';
import { fileSize, geld, zeitspanne } from '../lib/format.js';

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
function Tacho({ anteil, wert, name, warnAb = 0.8, gutIstVoll = false }: {
  anteil: number; wert: string; name: string; warnAb?: number; gutIstVoll?: boolean;
}) {
  const a = Math.max(0, Math.min(1, anteil));
  const r = 34;                       /* Radius im Koordinatensystem */
  const umfang = 2 * Math.PI * r;
  const bogen = 0.75;                 /* 270 Grad von 360 */
  /* Bei Auslastung heißt voll „eng" — da gehört Rot hin. Bei „Team online"
     oder Besuchern heißt voll das Gegenteil, und ein roter Bogen wäre dort
     eine Warnung vor einer guten Nachricht. Deshalb die Richtung als
     Eigenschaft und nicht als Faustregel. */
  const farbe = gutIstVoll
    ? (a >= 0.5 ? 'var(--green)' : 'var(--cyan)')
    : a >= 0.92 ? 'var(--red)' : a >= warnAb ? 'var(--amber)' : 'var(--cyan)';
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

/* Ein Satz über die volle Breite statt einer Zeile mit leerem Namen: in
   `.syszeile` trägt der Name `flex: 1 1 auto`, ein leerer schöbe den Text
   nach rechts und ließe ihn in der schmalen Spalte zerfleddern. */
function Notiz({ text, ton }: { text: string; ton?: 'warn' }) {
  return <div className={`sys__notiz ${ton ? `sys__notiz--${ton}` : ''}`}>{text}</div>;
}

function Zeile({ name, wert, ton }: { name: string; wert: React.ReactNode; ton?: 'gut' | 'warn' }) {
  return (
    <div className="syszeile">
      <span className="syszeile__name">{name}</span>
      <span className={`syszeile__wert ${ton ? `syszeile__wert--${ton}` : ''}`}>{wert}</span>
    </div>
  );
}

/* "9,2 GB" statt "9873154" — dieselbe Funktion wie überall sonst in der App,
   nur einmal richtig gemacht (lib/format.ts) statt hier ein zweites Mal mit
   festen Einheiten und Punkt als Dezimaltrennzeichen nachgebaut. */

function laufzeit(sek: number): string {
  // Dieselbe Bauart wie zeitspanne() unten (Intl mit style:'unit'), nur ohne
  // deren Rückfall auf "—" bei 0 — eine Laufzeit von 45 Minuten ist "0 Std.
  // 45 Min.", nicht "kein Wert".
  const einheit = (anzahl: number, unit: 'day' | 'hour' | 'minute') =>
    new Intl.NumberFormat(currentUiLanguage(), { style: 'unit', unit, unitDisplay: 'short' }).format(anzahl);
  const t = Math.floor(sek / 86400);
  const h = Math.floor((sek % 86400) / 3600);
  if (t > 0) return `${einheit(t, 'day')} ${einheit(h, 'hour')}`;
  return `${einheit(h, 'hour')} ${einheit(Math.floor((sek % 3600) / 60), 'minute')}`;
}

/* "55 °C" statt nacktem "55°" — ohne Buchstaben ist die Zahl nicht einmal
   eindeutig Celsius. Bleibt bewusst Celsius statt Fahrenheit für en-US: der
   Wert ist eine Pi-Hardwaregrenze (85 °C ist die vom Hersteller dokumentierte
   Drosselschwelle, siehe unten), keine Umgebungstemperatur, und Werkzeuge für
   genau diese Zielgruppe — vcgencmd, htop, IPMI — zeigen CPU-Temperaturen
   weltweit in Celsius, auch in den USA. Eine Umrechnung bräuchte außerdem den
   Schwellenwert 85 mit, der als Hardwarekonstante in Celsius bleibt. */
function grad(temp: number): string {
  return new Intl.NumberFormat(currentUiLanguage(), { style: 'unit', unit: 'celsius', unitDisplay: 'short' }).format(Math.round(temp));
}

/* geld() und zeitspanne() zogen nach ../lib/format.ts um — dieselbe
   Formatierung braucht jetzt auch VerkaufDetailPanel.tsx, und eine zweite
   Kopie hier wäre irgendwann eine Stelle, an der beide Ansichten
   auseinanderlaufen. */

type Werte = Record<string, any>;

export function SystemPanel({ onClose }: { onClose: () => void }) {
  const t = useT();
  const [daten, setDaten] = useState<Werte | null>(null);
  const [fehler, setFehler] = useState<string | null>(null);
  const [da, setDa] = useState(true);
  /* Patreon kommt über eine eigene Route (siehe api.verkaufPatreonKennzahlen,
     services/patreon.ts) statt über `daten.abo` — die Konsole auf dem Pi
     kennt Patreon gar nicht, das bleibt Gumroads Weg. Ein Fehlschlag (nicht
     eingerichtet, gerade nicht erreichbar) bleibt hier `null` und blendet die
     Zeile einfach aus, statt die ganze Verkaufskachel zu stören. */
  const [patreon, setPatreon] = useState<Werte | null>(null);
  const [detailOffen, setDetailOffen] = useState(false);
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

  useEffect(() => {
    /* Erst fragen, wenn feststeht, dass die Verkaufskachel überhaupt zu
       sehen ist (siehe Kommentar weiter unten bei `daten.abo?.da`) — sonst
       liefe hier bei jedem ohne `verkauf.sehen` unnötig ein 403 auf. */
    if (!daten?.abo?.da || !laeuft.current) return;
    let eigenerLauf = true;
    api.verkaufPatreonKennzahlen()
      .then((w) => { if (eigenerLauf && laeuft.current) setPatreon(w); })
      .catch(() => { if (eigenerLauf && laeuft.current) setPatreon(null); });
    return () => { eigenerLauf = false; };
  }, [daten?.abo?.da]);

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
            <Tacho name={t('system.temperatur')} anteil={temp / 85} wert={grad(temp)} warnAb={0.82} />
          )}
          {/* Auslagerung nur zeigen, wo es sie gibt — ein Tacho, der immer
              auf null steht, weil gar kein Auslagerungsspeicher eingerichtet
              ist, sagt nichts. */}
          {(l.swap?.gesamt ?? 0) > 0 && (
            <Tacho name={t('system.swap')} anteil={(l.swap.belegt ?? 0) / l.swap.gesamt}
                   wert={`${Math.round(((l.swap.belegt ?? 0) / l.swap.gesamt) * 100)}%`} />
          )}
          {/* Wie viel vom Team gerade da ist. Nenner sind die Konten, nicht
              die Verbindungen: wer an zwei Geräten angemeldet ist, zählt
              trotzdem als eine Person. */}
          {(daten.inhalt?.users ?? 0) > 0 && (
            <Tacho name={t('system.teamOnline')} gutIstVoll
                   anteil={(daten.verbunden?.benutzer ?? 0) / daten.inhalt.users}
                   wert={`${daten.verbunden?.benutzer ?? 0}/${daten.inhalt.users}`} />
          )}
          {/* Besucher der Webseite. Beide Nenner wachsen mit: „gerade da" im
              Verhältnis zur letzten halben Stunde, „heute" zum besten Tag.
              Ein fester Nenner wäre geraten und stünde nach der ersten guten
              Woche daneben. */}
          {w?.da && w.zugriff !== false && (
            <>
              <Tacho name={t('system.webJetzt')} gutIstVoll
                     anteil={(w.jetzt ?? 0) / Math.max(w.jetzt30 ?? 0, w.jetzt ?? 0, 1)}
                     wert={String(w.jetzt ?? 0)} />
              <Tacho name={t('system.webHeute')} gutIstVoll
                     anteil={(w.heute?.besucher ?? 0) / Math.max(w.besteTag ?? 0, w.heute?.besucher ?? 0, 1)}
                     wert={String(w.heute?.besucher ?? 0)} />
            </>
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
            <Zeile name={t('system.datenbank')} wert={fileSize(daten.inhalt?.groesse ?? 0)} />
            <Zeile name={t('system.dateien')} wert={`${daten.ablage?.dateien ?? 0} · ${fileSize(ab.belegt ?? 0)}`} />
          </section>

          {w?.da && (
            <section className="sys__block">
              <h3 className="sys__titel"><Globe size={14} /> {t('system.webseite')}</h3>
              {/* Ohne Zugriff auf das Protokoll steht hier sonst überall 0 —
                  und das liest sich wie eine Seite ohne Besucher, nicht wie
                  eine Messung, die gar nicht stattgefunden hat. */}
              {w.zugriff === false && <Notiz ton="warn" text={t('system.keinProtokoll')} />}
              {w.geteilt && <Notiz text={t('system.geteilt')} />}
              {/* „261 · 326" sagt ohne diese Zeile nichts. Sie steht einmal
                  über beiden Zeilen statt zweimal daneben — in einer schmalen
                  Spalte ist das der Unterschied zwischen lesbar und
                  überladen. */}
              <Notiz text={t('system.besucherSeiten')} />
              <Zeile name={t('system.jetzt')} wert={w.jetzt ?? 0} />
              <Zeile name={t('system.heute')}
                     wert={`${w.heute?.besucher ?? 0} · ${w.heute?.seiten ?? 0}`} />
              <Zeile name={t('system.woche')}
                     wert={`${w.woche?.besucher ?? 0} · ${w.woche?.seiten ?? 0}`} />
              <Zeile name={t('system.fehler404')} wert={w.heute?.f404 ?? 0} />
              <Zeile name={t('system.fehler5xx')} ton={(w.heute?.f5xx ?? 0) > 0 ? 'warn' : undefined}
                     wert={w.heute?.f5xx ?? 0} />
              <Zeile name={t('system.uebertragen')} wert={fileSize(w.heute?.bytes ?? 0)} />
            </section>
          )}

          {/* Der Server lässt `abo` weg, wenn jemand `verkauf.sehen` nicht
              hat — deshalb genügt hier die Frage, ob das Feld da ist. Ein
              zweiter Rechtecheck in der Oberfläche wäre nicht nur doppelt,
              er könnte auch auseinanderlaufen: was der Server nicht schickt,
              kann die Ansicht nicht zeigen, und was er schickt, darf sie. */}
          {daten.abo?.da && (
            <section className="sys__block">
              <h3 className="sys__titel"><Wallet size={14} /> {t('system.verkauf')}</h3>
              {/* Ersetzt die frühere reine Mitgliederzahl: mit Token weiß die
                  Konsole, wer davon wirklich zahlt und wer noch in der
                  kostenlosen Probewoche sitzt (Auftrag: "wie viele noch in
                  der Probewoche sind") — genau die Aufschlüsselung zeigen,
                  statt einer Gesamtzahl, in der beides ununterscheidbar
                  steckt. Ohne Token bleibt es bei der öffentlichen Zahl,
                  siehe system.mitglieder unten. */}
              <Zeile name={daten.abo.abonnenten ? t('system.abonnenten') : t('system.mitglieder')}
                     wert={daten.abo.abonnenten
                       ? t('system.zahlendInProbe', {
                           zahlend: String(daten.abo.abonnenten.zahlend ?? 0),
                           probe: String(daten.abo.abonnenten.probe ?? 0),
                         })
                       : (daten.abo.mitglieder ?? '—')} />
              <Zeile name={t('system.umsatz')}
                     wert={geld(daten.abo.umsatz?.monatCent, daten.abo.umsatz?.waehrung ?? daten.abo.waehrung)} />
              {/* Vorher stand hier Gumroads roher Text ("$25+ a month") —
                  Englisch, ungeachtet der Oberflächensprache, und "+"
                  behauptete eine Staffelung, die es nicht gibt (siehe
                  umsatzRechnen() in stellium-konsole.mjs: alle Laufzeiten
                  kosten aufs Monat gerechnet dasselbe). Jetzt der Monatspreis
                  aus der geprüften Preisliste, mit derselben Intl-Formatierung
                  wie jede andere Geldzahl hier. Fehlt die Preisliste (z. B.
                  weil Gumroad gerade nicht antwortet), lieber "noch nicht
                  bekannt" als der rohe Text. */}
              <Zeile name={t('system.preis')} wert={(() => {
                const preise: any[] = Array.isArray(daten.abo.preise) ? daten.abo.preise : [];
                const monatspreis = preise.find((p) => p.monate === 1) ?? preise[0];
                return monatspreis
                  ? t('system.preisMonatlich', { betrag: geld(monatspreis.cent, daten.abo.waehrung) })
                  : t('system.preisUnbekannt');
              })()} />
              <Zeile name={t('system.probe')}
                     wert={zeitspanne(daten.abo.probe?.anzahl, daten.abo.probe?.einheit)} />
              {/* Ohne Gumroad-Token gibt es keine echten Einnahmen. Das steht
                  hier als Grund und nicht als Strich: „—" hieße „gerade
                  nichts verdient", und das wäre eine andere Aussage.

                  Mit Token ist es der Netto-Betrag der letzten `tage` Tage —
                  nicht seit Anfang. Der Zeitraum gehört daneben, sonst liest
                  sich dieselbe Zahl als Gesamteinnahme. Die Währung kommt aus
                  dem Einnahmenblock selbst und nicht von `abo.waehrung`: es
                  sind zwei Felder, und sie müssen nicht übereinstimmen.
                  `vollstaendig: false` heißt, Gumroad hatte mehr Seiten als
                  abgerufen wurden — dann ist der Betrag zu niedrig, und das
                  darf nicht wie eine gesicherte Zahl aussehen. */}
              <Zeile name={t('system.einnahmen')}
                     ton={daten.abo.einnahmen && daten.abo.einnahmen.vollstaendig === false ? 'warn' : undefined}
                     wert={!daten.abo.einnahmen
                       ? t('system.keinToken')
                       : `${geld(daten.abo.einnahmen.nettoCent, daten.abo.einnahmen.waehrung)}`
                         + ` · ${zeitspanne(daten.abo.einnahmen.tage, 'day', 'short')}`} />
              {/* Patreon steht neben Gumroad, nicht darunter vermischt — beide
                  Anbieter zählen unterschiedlich (Unterstützer statt
                  Abonnenten, keine Probezeit), eine gemeinsame Zeile würde
                  Äpfel mit Birnen summieren. Nur sichtbar, wenn Patreon
                  wirklich eingerichtet UND erreichbar ist (siehe Effekt oben)
                  — sonst fehlt die Zeile einfach, statt einen Fehler zu
                  zeigen, der niemanden betrifft, der kein Patreon nutzt. */}
              {patreon && (
                <Zeile name={t('system.patreon')}
                       wert={t('system.patreonZeile', {
                         aktiv: String(patreon.aktiveUnterstuetzer ?? 0),
                         betrag: geld(patreon.monatlicheEinnahmenCents, patreon.waehrung),
                       })} />
              )}
              <button type="button" className="btn btn--ghost btn--sm sys__mehr" onClick={() => setDetailOffen(true)}>
                {t('system.alleZahlenAnsehen')} <ChevronRight size={13} />
              </button>
            </section>
          )}

          <section className="sys__block">
            <h3 className="sys__titel"><HardDrive size={14} /> {t('system.netz')}</h3>
            <Zeile name={t('system.empfangen')} wert={fileSize(l.netz?.rein ?? 0)} />
            <Zeile name={t('system.gesendet')} wert={fileSize(l.netz?.raus ?? 0)} />
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
    <>
      <Shell title={t('system.titel')} icon={<GaugeIcon size={16} />} onClose={onClose} width={860}>
        {inhalt()}
      </Shell>
      {detailOffen && <VerkaufDetailPanel onClose={() => setDetailOffen(false)} />}
    </>
  );
}
