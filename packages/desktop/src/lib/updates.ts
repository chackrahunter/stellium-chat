import { useStore } from '../state/store.js';

/**
 * Meldungen des Hauptprozesses in den Zustand übernehmen.
 * Einmal beim Start aufgerufen; im Browser passiert nichts.
 */
export function updatesVerbinden(): () => void {
  if (!window.stellium?.onUpdate) return () => {};

  return window.stellium.onUpdate((art, daten) => {
    const d = (daten ?? {}) as { version?: string; notes?: string | null; geladen?: number; gesamt?: number; message?: string };
    switch (art) {
      case 'found':
        useStore.setState({ update: { zustand: 'gefunden', version: d.version, notes: d.notes ?? null } });
        break;
      case 'progress':
        useStore.setState({
          update: {
            zustand: 'laedt',
            version: d.version,
            anteil: d.gesamt ? Math.min(1, (d.geladen ?? 0) / d.gesamt) : 0,
          },
        });
        break;
      case 'ready':
        useStore.setState({ update: { zustand: 'bereit', version: d.version, notes: d.notes ?? null } });
        useStore.getState().toast({
          kind: 'ok',
          title: `Version ${d.version} ist bereit`,
          body: 'In den Einstellungen kannst du sie jetzt installieren.',
        });
        break;
      case 'none':
        useStore.setState({ update: { zustand: 'aktuell', version: d.version } });
        break;
      case 'error':
        useStore.setState({ update: { zustand: 'fehler', fehler: d.message } });
        break;
    }
  });
}
