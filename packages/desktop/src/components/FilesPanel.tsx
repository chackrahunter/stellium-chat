import { useEffect, useMemo, useRef, useState } from 'react';
import { AnimatePresence, motion } from 'framer-motion';
import {
  Download, File as FileIcon, FileText, FolderOpen, Hash, Image as ImageIcon,
  Loader2, Music, Pencil, Search, Trash2, Upload, Video,
} from 'lucide-react';
import type { StoredFile } from '@stellium/shared';
import { useStore } from '../state/store.js';
import { useT } from '../i18n/index.js';
import { Avatar } from './Avatar.jsx';
import { Shell } from './Panels.jsx';
import { dateiUrl } from '../net/api.js';
import { clsx, relativeTime } from '../lib/format.js';

function groesse(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const einheiten = ['KB', 'MB', 'GB', 'TB'];
  let wert = bytes / 1024;
  let i = 0;
  while (wert >= 1024 && i < einheiten.length - 1) { wert /= 1024; i += 1; }
  return `${wert < 10 ? wert.toFixed(1) : Math.round(wert)} ${einheiten[i]}`;
}

function symbol(mime: string) {
  if (mime.startsWith('image/')) return <ImageIcon size={17} />;
  if (mime.startsWith('video/')) return <Video size={17} />;
  if (mime.startsWith('audio/')) return <Music size={17} />;
  if (mime === 'application/pdf' || mime.startsWith('text/')) return <FileText size={17} />;
  return <FileIcon size={17} />;
}

export function FilesPanel({ onClose }: { onClose: () => void }) {
  const t = useT();
  const files = useStore((s) => s.files);
  const usage = useStore((s) => s.storageUsage);
  const users = useStore((s) => s.users);
  const channels = useStore((s) => s.channels);
  const self = useStore((s) => s.self);
  const { loadFiles, uploadFile, deleteFile, updateFile } = useStore.getState();

  const [suche, setSuche] = useState('');
  const [ordner, setOrdner] = useState('');
  const [laedt, setLaedt] = useState(false);
  const [ueberZone, setUeberZone] = useState(false);
  const dateiFeld = useRef<HTMLInputElement>(null);

  useEffect(() => { loadFiles(); }, [loadFiles]);

  const ordnerListe = useMemo(
    () => [...new Set(files.map((f) => f.folder).filter(Boolean))].sort(),
    [files],
  );

  const sichtbar = useMemo(() => {
    const q = suche.trim().toLowerCase();
    return files.filter((f) => {
      if (ordner === '__root' ? f.folder !== '' : ordner && f.folder !== ordner) return false;
      if (!q) return true;
      return f.name.toLowerCase().includes(q) || (f.description ?? '').toLowerCase().includes(q);
    });
  }, [files, suche, ordner]);

  const hochladen = async (liste: FileList | null) => {
    if (!liste?.length) return;
    setLaedt(true);
    try {
      // Nacheinander, damit das Kontingent sauber geprüft wird.
      for (const datei of Array.from(liste)) {
        await uploadFile(datei, { folder: ordner && ordner !== '__root' ? ordner : undefined });
      }
    } finally {
      setLaedt(false);
    }
  };

  const anteil = usage && usage.quota > 0 ? Math.min(1, usage.used / usage.quota) : 0;

  return (
    <Shell
      title={t('files.title')}
      subtitle={usage ? t('files.usage', { used: groesse(usage.used), quota: groesse(usage.quota) }) : t('files.subtitle')}
      icon={<FolderOpen size={18} />}
      onClose={onClose}
      width={980}
      actions={
        <button
          className="pill pill--accent"
          onClick={() => dateiFeld.current?.click()}
          disabled={laedt || !self?.permissions['file.upload']}
        >
          {laedt ? <Loader2 size={13} className="spin" /> : <Upload size={13} />}
          {laedt ? t('files.uploading') : t('files.upload')}
        </button>
      }
    >
      <input
        ref={dateiFeld}
        type="file"
        multiple
        hidden
        onChange={(e) => { void hochladen(e.target.files); e.target.value = ''; }}
      />

      {usage && (
        <div className="quota">
          <motion.span
            className="quota__fill"
            style={{ background: anteil > 0.9 ? 'var(--red)' : 'var(--violet)' }}
            initial={{ width: 0 }}
            animate={{ width: `${anteil * 100}%` }}
            transition={{ duration: 0.5, ease: [0.16, 1, 0.3, 1] }}
          />
        </div>
      )}

      <div className="files-bar">
        <div className="files-search">
          <Search size={14} className="muted" />
          <input
            className="input input--bare"
            value={suche}
            placeholder={t('files.searchPlaceholder')}
            onChange={(e) => setSuche(e.target.value)}
          />
        </div>
        <select className="select" value={ordner} onChange={(e) => setOrdner(e.target.value)}>
          <option value="">{t('files.allFolders')}</option>
          <option value="__root">{t('files.rootFolder')}</option>
          {ordnerListe.map((o) => <option key={o} value={o}>{o}</option>)}
        </select>
      </div>

      <div
        className={clsx('dropzone', ueberZone && 'dropzone--over')}
        onDragOver={(e) => { e.preventDefault(); setUeberZone(true); }}
        onDragLeave={() => setUeberZone(false)}
        onDrop={(e) => { e.preventDefault(); setUeberZone(false); void hochladen(e.dataTransfer.files); }}
      >
        {!sichtbar.length ? (
          <div className="empty-state">
            <Upload size={28} className="muted" />
            <p>{files.length ? t('files.empty') : t('files.dropHint')}</p>
          </div>
        ) : (
          <div className="file-list">
            <AnimatePresence initial={false}>
              {sichtbar.map((f) => (
                <FileRow key={f.id} file={f} />
              ))}
            </AnimatePresence>
          </div>
        )}
      </div>
    </Shell>
  );

  function FileRow({ file }: { file: StoredFile }) {
    const wer = users[file.uploadedBy];
    const kanal = file.channelId ? channels[file.channelId] : null;
    const eigene = file.uploadedBy === self?.id;
    const darf = eigene || self?.permissions['file.manage'];

    return (
      <motion.div
        layout
        className="file-row"
        initial={{ opacity: 0, y: 5 }}
        animate={{ opacity: 1, y: 0 }}
        exit={{ opacity: 0, height: 0 }}
        transition={{ duration: 0.16 }}
      >
        <span className="file-row__icon">{symbol(file.mime)}</span>

        <span className="file-row__main">
          <span className="file-row__name">{file.name}</span>
          <span className="file-row__meta">
            {groesse(file.size)}
            {file.folder && <> · <FolderOpen size={10} /> {file.folder}</>}
            {kanal && <> · <Hash size={10} />{kanal.name}</>}
            {' · '}{t('files.uploadedBy', { name: wer?.displayName ?? '—' })}
            {' · '}{relativeTime(file.createdAt)}
          </span>
        </span>

        {wer && <Avatar user={wer} size={22} />}

        <a
          className="icon-btn"
          href={dateiUrl(file.url)}
          target="_blank"
          rel="noreferrer"
          title={t('files.download')}
        >
          <Download size={15} />
        </a>

        {darf && (
          <button
            className="icon-btn"
            title={t('files.rename')}
            onClick={() => {
              const name = prompt(t('files.rename'), file.name);
              if (name && name.trim() && name !== file.name) updateFile(file.id, { name: name.trim() });
            }}
          >
            <Pencil size={15} />
          </button>
        )}

        {darf && (
          <button
            className="icon-btn icon-btn--danger"
            title={t('files.delete')}
            onClick={() => { if (confirm(t('files.deleteConfirm'))) deleteFile(file.id); }}
          >
            <Trash2 size={15} />
          </button>
        )}
      </motion.div>
    );
  }
}
