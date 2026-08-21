import { useState } from 'react';
import { Archive, ArchiveRestore, FolderKanban, Plus, Trash2 } from 'lucide-react';
import { PROJEKT_FARBEN } from '@stellium/shared';
import { useStore } from '../state/store.js';
import { useT } from '../i18n/index.js';
import { Shell } from './Panels.jsx';
import { clsx } from '../lib/format.js';

/**
 * Projekte anlegen und verwalten.
 *
 * Ein Projekt ist hier eine Schublade für Aufgaben — Name, Farbe, ein Satz
 * dazu. Kein zweites Aufgabenbrett: Fortschritt steht als Zahl daneben, alles
 * Weitere hängt an den Aufgaben selbst.
 *
 * Archivieren statt löschen ist der Normalweg. Löschen nimmt die Schublade
 * weg, nicht die Arbeit: die Aufgaben bleiben und liegen danach ohne Projekt.
 */
export function ProjektDialog({ onClose }: { onClose: () => void }) {
  const t = useT();
  const projekte = useStore((s) => s.projekte);
  const { createProjekt, updateProjekt, deleteProjekt } = useStore.getState();

  const [name, setName] = useState('');
  const [beschreibung, setBeschreibung] = useState('');
  const [farbe, setFarbe] = useState<string>(PROJEKT_FARBEN[0]);

  const anlegen = () => {
    if (name.trim().length < 2) return;
    createProjekt({ name: name.trim(), beschreibung: beschreibung.trim() || null, farbe });
    setName('');
    setBeschreibung('');
  };

  const liste = Object.values(projekte)
    .sort((a, b) => Number(a.archiviert) - Number(b.archiviert) || a.name.localeCompare(b.name));

  return (
    <Shell title={t('projekte.title')} icon={<FolderKanban size={18} />} onClose={onClose} width={520}>
      <div className="field">
        <label className="field__label">{t('projekte.name')}</label>
        <input
          className="input"
          value={name}
          autoFocus
          placeholder={t('projekte.namePlaceholder')}
          onChange={(e) => setName(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter') anlegen(); }}
        />
      </div>

      <div className="field">
        <label className="field__label">{t('projekte.description')}</label>
        <input
          className="input"
          value={beschreibung}
          onChange={(e) => setBeschreibung(e.target.value)}
        />
      </div>

      <div className="field">
        <label className="field__label">{t('projekte.color')}</label>
        <div className="farbwahl">
          {PROJEKT_FARBEN.map((f) => (
            <button
              key={f}
              className={clsx('farbwahl__punkt', farbe === f && 'farbwahl__punkt--an')}
              style={{ background: f }}
              onClick={() => setFarbe(f)}
              aria-label={f}
            />
          ))}
        </div>
      </div>

      <button className="btn btn--primary" onClick={anlegen} disabled={name.trim().length < 2}>
        <Plus size={14} /> {t('projekte.create')}
      </button>

      <div className="projekt-liste">
        {!liste.length && <p className="muted">{t('projekte.empty')}</p>}
        {liste.map((p) => (
          <div key={p.id} className={clsx('projekt-zeile', p.archiviert && 'projekt-zeile--archiv')}>
            <span className="projekt-punkt" style={{ background: p.farbe }} />
            <div className="projekt-zeile__text">
              <span className="projekt-zeile__name">{p.name}</span>
              <span className="projekt-zeile__zahl">
                {t('projekte.progress', { done: p.fertig, total: p.aufgaben })}
                {p.archiviert ? ` \u00b7 ${t('projekte.archived')}` : ''}
              </span>
            </div>
            <button
              className="icon-btn"
              onClick={() => updateProjekt(p.id, { archiviert: !p.archiviert })}
              title={p.archiviert ? t('projekte.unarchive') : t('projekte.archive')}
            >
              {p.archiviert ? <ArchiveRestore size={14} /> : <Archive size={14} />}
            </button>
            <button
              className="icon-btn"
              onClick={() => { if (confirm(t('projekte.deleteConfirm'))) deleteProjekt(p.id); }}
              title={t('projekte.delete')}
            >
              <Trash2 size={14} />
            </button>
          </div>
        ))}
      </div>
    </Shell>
  );
}
