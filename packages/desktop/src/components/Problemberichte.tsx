import { useEffect, useState } from 'react';
import { Bug, Check, RotateCcw } from 'lucide-react';
import {
  PROBLEMBERICHT_BEREICHE, PROBLEMBERICHT_SCHWEREN,
  type Problembericht, type ProblemberichtBereich, type ProblemberichtSchwere,
} from '@stellium/shared';
import { useStore } from '../state/store.js';
import { useProblemberichteUi } from '../state/problemberichte.js';
import { useT, type TranslationKey } from '../i18n/index.js';
import { Shell } from './Panels.jsx';
import { Avatar } from './Avatar.jsx';
import { clsx, relativeTime } from '../lib/format.js';

/**
 * Der Tab „Probleme melden".
 *
 * Drei Reiter: „Neu melden" (das Formular — der Grund, warum es diesen Tab
 * überhaupt gibt), „Meine Meldungen" (was diese Person selbst eingereicht
 * hat, mit Status) und, nur mit `report.review`, „Alle" (die Warteschlange,
 * mit den Knöpfen zum Übernehmen und Abschließen). Der Server entscheidet
 * ohnehin, was in `liste` steht — ohne das Recht kommen dort nur die eigenen
 * Berichte an, „Alle" wäre also nur eine zweite Ansicht auf dasselbe.
 */
export function Problemberichte({ onClose }: { onClose: () => void }) {
  const t = useT();
  const self = useStore((s) => s.self);
  const { erkannterBereich, liste, laden } = useProblemberichteUi();
  const darfAlle = Boolean(self?.permissions['report.review']);

  const [reiter, setReiter] = useState<'neu' | 'meine' | 'alle'>('neu');
  const [offen, setOffen] = useState<string | null>(null);

  useEffect(() => { laden(); }, [laden]);

  const meine = liste.filter((b) => b.createdBy.id === self?.id);
  const angezeigt = reiter === 'meine' ? meine : liste;

  return (
    <Shell title={t('problembericht.nav')} icon={<Bug size={18} />} onClose={onClose} width={640}>
      <div className="vorschlag-leiste">
        <button
          className={clsx('vorschlag-tab', reiter === 'neu' && 'vorschlag-tab--on')}
          onClick={() => setReiter('neu')}
        >
          {t('problembericht.tab.neu')}
        </button>
        <button
          className={clsx('vorschlag-tab', reiter === 'meine' && 'vorschlag-tab--on')}
          onClick={() => setReiter('meine')}
        >
          {t('problembericht.tab.meine')} <span className="vorschlag-tab__n">{meine.length}</span>
        </button>
        {darfAlle && (
          <button
            className={clsx('vorschlag-tab', reiter === 'alle' && 'vorschlag-tab--on')}
            onClick={() => setReiter('alle')}
          >
            {t('problembericht.tab.alle')} <span className="vorschlag-tab__n">{liste.length}</span>
          </button>
        )}
      </div>

      {reiter === 'neu' ? (
        <NeueMeldung erkannterBereich={erkannterBereich} onDone={() => setReiter('meine')} />
      ) : !angezeigt.length ? (
        <div className="empty-state">
          <Bug size={30} className="muted" />
          <p>{t('common.nothingFound')}</p>
        </div>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
          {angezeigt.map((b) => (
            <BerichtZeile key={b.id} bericht={b} mitAutor={reiter === 'alle'} onOpen={() => setOffen(b.id)} />
          ))}
        </div>
      )}

      {offen && angezeigt.find((b) => b.id === offen) && (
        <BerichtDetail
          bericht={angezeigt.find((b) => b.id === offen)!}
          darfBearbeiten={darfAlle}
          onClose={() => setOffen(null)}
        />
      )}
    </Shell>
  );
}

const STATUS_FARBE: Record<Problembericht['status'], string> = {
  neu: 'var(--blue)', in_arbeit: 'var(--amber)', erledigt: 'var(--green)',
};
const SCHWERE_FARBE: Record<ProblemberichtSchwere, string> = {
  blockiert: 'var(--red)', stoert: 'var(--amber)', kleinigkeit: 'var(--tx-lo)',
};

function BerichtZeile({ bericht, mitAutor, onOpen }: {
  bericht: Problembericht; mitAutor: boolean; onOpen: () => void;
}) {
  const t = useT();
  const users = useStore((s) => s.users);
  const autor = mitAutor ? users[bericht.createdBy.id] : undefined;
  return (
    <button
      onClick={onOpen}
      style={{
        display: 'flex', alignItems: 'center', gap: 10, padding: '8px 10px',
        borderRadius: 'var(--r-sm)', background: 'var(--bg-panel)', border: '1px solid var(--line)',
        textAlign: 'start', width: '100%',
      }}
    >
      <span style={{ width: 8, height: 8, borderRadius: '50%', flex: 'none', background: STATUS_FARBE[bericht.status] }} />
      <span style={{ flex: 1, minWidth: 0, display: 'grid', gap: 3 }}>
        <span style={{ fontSize: 13, overflowWrap: 'anywhere' }}>
          {bericht.unvertrauterInhalt.passiert}
        </span>
        <span className="muted hstack" style={{ gap: 6, fontSize: 11, flexWrap: 'wrap' }}>
          <span>{t(`problembericht.bereich.${bericht.bereich}` as TranslationKey)}</span>
          · <span style={{ color: SCHWERE_FARBE[bericht.schwere] }}>{t(`problembericht.schwere.${bericht.schwere}` as TranslationKey)}</span>
          · <span>{t(`problembericht.status.${bericht.status}` as TranslationKey)}</span>
          {autor && <>· <Avatar user={autor} size={14} /> {autor.displayName}</>}
          · {relativeTime(bericht.createdAt)}
        </span>
      </span>
    </button>
  );
}

/** Das Formular. Eigene Komponente statt Teil von Problemberichte(): die
 *  Felder sollen nach dem Absenden wieder leer sein, und lokaler Zustand in
 *  einer eigenen Komponente ist dafür einfacher als ihn von außen
 *  zurückzusetzen. */
function NeueMeldung({ erkannterBereich, onDone }: {
  erkannterBereich: ProblemberichtBereich; onDone: () => void;
}) {
  const t = useT();
  const { einreichen, sendeFehler } = useProblemberichteUi();
  const [bereich, setBereich] = useState<ProblemberichtBereich>(erkannterBereich);
  const [schwere, setSchwere] = useState<ProblemberichtSchwere>('stoert');
  const [erwartet, setErwartet] = useState('');
  const [passiert, setPassiert] = useState('');
  const [schritte, setSchritte] = useState('');
  const [sendet, setSendet] = useState(false);

  const gueltig = erwartet.trim().length >= 3 && passiert.trim().length >= 3;

  const absenden = async () => {
    if (!gueltig || sendet) return;
    setSendet(true);
    try {
      await einreichen({
        bereich, schwere, erwartet: erwartet.trim(), passiert: passiert.trim(),
        schritte: schritte.trim() || undefined,
      });
      useStore.getState().toast({ kind: 'ok', title: t('problembericht.submitted') });
      setErwartet(''); setPassiert(''); setSchritte('');
      onDone();
    } catch (err) {
      useStore.getState().toast({ kind: 'error', title: t('problembericht.nav'), body: (err as Error).message });
    } finally {
      setSendet(false);
    }
  };

  return (
    <>
      <div className="grid-2">
        <div className="field">
          <label className="field__label">{t('problembericht.field.bereich')}</label>
          <select className="select" value={bereich} onChange={(e) => setBereich(e.target.value as ProblemberichtBereich)}>
            {PROBLEMBERICHT_BEREICHE.map((b) => (
              <option key={b} value={b}>{t(`problembericht.bereich.${b}` as TranslationKey)}</option>
            ))}
          </select>
        </div>
        <div className="field">
          <label className="field__label">{t('problembericht.field.schwere')}</label>
          <div className="hstack" style={{ gap: 5 }}>
            {PROBLEMBERICHT_SCHWEREN.map((s) => (
              <button
                key={s}
                type="button"
                className={clsx('pill', schwere === s && 'pill--accent')}
                onClick={() => setSchwere(s)}
              >
                {t(`problembericht.schwere.${s}` as TranslationKey)}
              </button>
            ))}
          </div>
        </div>
      </div>

      <div className="field">
        <label className="field__label">{t('problembericht.field.erwartet')}</label>
        <textarea
          className="input" rows={2} value={erwartet} placeholder={t('problembericht.field.erwartetPlaceholder')}
          onChange={(e) => setErwartet(e.target.value)}
        />
      </div>

      <div className="field">
        <label className="field__label">{t('problembericht.field.passiert')}</label>
        <textarea
          className="input" rows={2} value={passiert} placeholder={t('problembericht.field.passiertPlaceholder')}
          onChange={(e) => setPassiert(e.target.value)}
        />
      </div>

      <div className="field">
        <label className="field__label">{t('problembericht.field.schritte')}</label>
        <textarea
          className="input" rows={2} value={schritte} placeholder={t('problembericht.field.schrittePlaceholder')}
          onChange={(e) => setSchritte(e.target.value)}
        />
      </div>

      {sendeFehler && <p className="field__hint" style={{ color: 'var(--red)' }}>{sendeFehler}</p>}

      <div className="panel__foot">
        <button className="btn btn--primary" disabled={!gueltig || sendet} onClick={absenden}>
          {t('problembericht.submit')}
        </button>
      </div>
    </>
  );
}

/** Einzelansicht — mit Kontext (Fassung, Plattform, erkannter Bereich,
 *  Sprache) und, mit report.review, den Knöpfen zum Übernehmen/Abschließen. */
function BerichtDetail({ bericht, darfBearbeiten, onClose }: {
  bericht: Problembericht; darfBearbeiten: boolean; onClose: () => void;
}) {
  const t = useT();
  const { uebernehmen, abschliessen } = useProblemberichteUi();
  const [ergebnis, setErgebnis] = useState(bericht.unvertrauterInhalt.ergebnis ?? '');
  const [laeuft, setLaeuft] = useState(false);

  const speichern = async (status: 'erledigt' | 'neu') => {
    if (!ergebnis.trim() || laeuft) return;
    setLaeuft(true);
    try { await abschliessen(bericht.id, ergebnis.trim(), status); onClose(); }
    finally { setLaeuft(false); }
  };

  return (
    <Shell
      title={t(`problembericht.bereich.${bericht.bereich}` as TranslationKey)}
      subtitle={`${t(`problembericht.status.${bericht.status}` as TranslationKey)} · ${relativeTime(bericht.createdAt)}`}
      icon={<Bug size={18} />}
      onClose={onClose}
      width={520}
    >
      <div className="field">
        <label className="field__label">{t('problembericht.field.erwartet')}</label>
        <p style={{ fontSize: 13, whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' }}>{bericht.unvertrauterInhalt.erwartet}</p>
      </div>
      <div className="field">
        <label className="field__label">{t('problembericht.field.passiert')}</label>
        <p style={{ fontSize: 13, whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' }}>{bericht.unvertrauterInhalt.passiert}</p>
      </div>
      {bericht.unvertrauterInhalt.schritte && (
        <div className="field">
          <label className="field__label">{t('problembericht.field.schritte')}</label>
          <p style={{ fontSize: 13, whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' }}>{bericht.unvertrauterInhalt.schritte}</p>
        </div>
      )}

      <p className="muted" style={{ fontSize: 11 }}>
        {bericht.kontext.clientPlatform ?? '—'}
        {bericht.kontext.clientVersion ? ` ${bericht.kontext.clientVersion}` : ''}
        {' · '}{bericht.kontext.sprache}
      </p>

      {darfBearbeiten && bericht.status !== 'erledigt' && (
        <>
          {bericht.status === 'neu' && (
            <div className="panel__foot" style={{ justifyContent: 'flex-start' }}>
              <button className="btn" onClick={() => uebernehmen(bericht.id)}>{t('problembericht.take')}</button>
            </div>
          )}
          <div className="field">
            <label className="field__label">{t('problembericht.ergebnisLabel')}</label>
            <textarea className="input" rows={2} value={ergebnis} onChange={(e) => setErgebnis(e.target.value)} />
          </div>
          <div className="panel__foot">
            <button className="btn" disabled={!ergebnis.trim() || laeuft} onClick={() => speichern('neu')}>
              <RotateCcw size={13} /> {t('problembericht.reopen')}
            </button>
            <button className="btn btn--primary" disabled={!ergebnis.trim() || laeuft} onClick={() => speichern('erledigt')}>
              <Check size={13} /> {t('problembericht.finish')}
            </button>
          </div>
        </>
      )}

      {bericht.status === 'erledigt' && bericht.unvertrauterInhalt.ergebnis && (
        <div className="field">
          <label className="field__label">{t('problembericht.ergebnisLabel')}</label>
          <p style={{ fontSize: 13, whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' }}>{bericht.unvertrauterInhalt.ergebnis}</p>
        </div>
      )}
    </Shell>
  );
}
