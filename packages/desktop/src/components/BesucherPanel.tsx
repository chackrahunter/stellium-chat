import { useEffect, useState } from 'react';
import { AlertTriangle, CalendarDays, FileText, Globe, Languages, Loader2, MonitorSmartphone, Users } from 'lucide-react';
import { Shell } from './Panels.jsx';
import { Balkenreihe, Kennzahl, Notiz, Zeile } from './VerkaufDetailPanel.jsx';
import { useT, currentUiLanguage, type TranslationKey } from '../i18n';
import { api, type Webbesuch } from '../net/api.js';
import { dateTime } from '../lib/format.js';

/**
 * Die Besucher von stellium.club — ausführlich, ein Klick von der
 * Webseiten-Kachel in SystemPanel.tsx oder aus dem Stern-Menü.
 *
 * Alles außer „insgesamt" stammt aus dem Signal der Seite (server
 * services/webbesuch.ts); das gibt es erst seit seinem Einbau. „Insgesamt"
 * reicht weiter zurück und kommt deshalb aus dem Server-Protokoll — mit
 * Datum daneben, damit klar ist, woher die größere Zahl stammt.
 */

function zahl(n: number): string {
  return new Intl.NumberFormat(currentUiLanguage()).format(n);
}

function tagAnzeigen(tag: string): string {
  return new Intl.DateTimeFormat(currentUiLanguage(), { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' })
    .format(new Date(`${tag}T00:00:00Z`));
}

/* Ländercodes und Sprachkürzel benennt der Browser selbst in der Sprache der
   Oberfläche — ein eigenes Wörterbuch für 250 Länder wäre Unsinn. */
function benenner(art: 'region' | 'language') {
  let d: Intl.DisplayNames | null = null;
  try { d = new Intl.DisplayNames([currentUiLanguage()], { type: art }); } catch { /* alter Browser */ }
  return (code: string) => {
    try { return d?.of(code) ?? code; } catch { return code; }
  };
}

export function BesucherPanel({ onClose }: { onClose: () => void }) {
  const t = useT();
  const [daten, setDaten] = useState<Webbesuch | null>(null);
  const [fehler, setFehler] = useState<string | null>(null);

  useEffect(() => {
    let laeuft = true;
    const holen = () => api.webbesuch()
      .then((w) => { if (laeuft) { setDaten(w); setFehler(null); } })
      .catch((f: Error) => { if (laeuft) setFehler(f.message); });
    holen();
    /* Das Signal kommt einmal die Minute je offener Seite — häufiger zu
       fragen, brächte kaum Neues. */
    const takt = window.setInterval(holen, 15_000);
    return () => { laeuft = false; window.clearInterval(takt); };
  }, []);

  const unbekannt = (wert: string, name: (w: string) => string) => (wert === '?' ? t('besucher.unbekannt') : name(wert));
  const reihe = (liste: [string, number][], name: (w: string) => string) => (
    <div className="besucher__balken">
      <Balkenreihe eintraege={liste.map(([w, n]) => ({ label: name(w), wert: n, text: zahl(n) }))} />
    </div>
  );

  const inhalt = () => {
    if (fehler) return <div className="sys__leer"><AlertTriangle size={15} /> {fehler}</div>;
    if (!daten) return <div className="sys__leer"><Loader2 size={16} className="dreht" /></div>;
    const land = benenner('region');
    const sprache = benenner('language');
    const p = daten.protokoll;
    const zeitraum = (z: { besucher: number; aufrufe: number }) =>
      t('system.besucherAufrufeZeile', { besucher: zahl(z.besucher), seiten: zahl(z.aufrufe) });

    return (
      <div className="sys verkauf__detail">
        <section className="sys__block verkauf__kopf">
          <Kennzahl label={t('system.jetzt')} wert={zahl(daten.jetzt)} />
          <Kennzahl label={t('system.heute')} wert={zahl(daten.heute.besucher)} />
          <Kennzahl label={t('besucher.tage7')} wert={zahl(daten.tage7.besucher)} />
          <Kennzahl label={t('besucher.tage30')} wert={zahl(daten.tage30.besucher)} />
          <Kennzahl label={t('besucher.gesamt')} wert={zahl(p ? p.gesamt.besucher : daten.gesamt.besucher)} />
        </section>

        <section className="sys__block">
          <h3 className="sys__titel"><CalendarDays size={14} /> {t('besucher.zeitraeume')}</h3>
          <Zeile name={t('system.heute')} wert={zeitraum(daten.heute)} />
          <Zeile name={t('besucher.tage7')} wert={zeitraum(daten.tage7)} />
          <Zeile name={t('besucher.tage30')} wert={zeitraum(daten.tage30)} />
          {p && (
            <Zeile name={t('besucher.protokoll', { datum: tagAnzeigen(p.gesamt.seit) })}
                   wert={t('system.besucherAufrufeZeile', { besucher: zahl(p.gesamt.besucher), seiten: zahl(p.gesamt.seiten) })} />
          )}
          {p && <Notiz text={t('besucher.protokollHinweis', { zeit: dateTime(p.stand) })} />}
          {daten.seit && <Notiz text={t('besucher.seit', { datum: tagAnzeigen(daten.seit) })} />}
        </section>

        {!daten.seit ? <Notiz text={t('besucher.leer')} /> : (
          <>
            <section className="sys__block">
              <h3 className="sys__titel"><FileText size={14} /> {t('besucher.seiten')} · {t('besucher.letzte30')}</h3>
              {reihe(daten.seiten, (w) => (w === '(andere)' ? t('besucher.andere') : w))}
            </section>
            <section className="sys__block">
              <h3 className="sys__titel"><Globe size={14} /> {t('besucher.laender')}</h3>
              {reihe(daten.laender, (w) => unbekannt(w, land))}
            </section>
            <section className="sys__block">
              <h3 className="sys__titel"><Languages size={14} /> {t('besucher.sprachen')}</h3>
              {reihe(daten.sprachen, (w) => unbekannt(w, sprache))}
            </section>
            <section className="sys__block">
              <h3 className="sys__titel"><MonitorSmartphone size={14} /> {t('besucher.geraete')}</h3>
              {reihe(daten.geraete, (w) => t(`besucher.geraet.${w}` as TranslationKey))}
            </section>
          </>
        )}
        <Notiz text={t('besucher.erklaerung')} />
      </div>
    );
  };

  return (
    <Shell title={t('besucher.titel')} icon={<Users size={16} />} onClose={onClose} width={620}>
      {inhalt()}
    </Shell>
  );
}
