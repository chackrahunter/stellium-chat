import { useStore } from '../state/store.js';

/**
 * Meldungen des Hauptprozesses in den Zustand übernehmen.
 * Einmal beim Start aufgerufen; im Browser passiert nichts.
 */
/** Zählt die Restzeit herunter — der Hauptprozess meldet nur den Startwert. */
let uhr: ReturnType<typeof setInterval> | null = null;

export function updatesVerbinden(): () => void {
  if (!window.stellium?.onUpdate) return () => {};

  return window.stellium.onUpdate((art, daten) => {
    const d = (daten ?? {}) as {
      version?: string; notes?: string | null; geladen?: number; gesamt?: number;
      message?: string; sekunden?: number;
    };
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
      case 'deadline': {
        // Die Uhr läuft im Hauptprozess; hier nur mitzählen, damit der
        // Hinweis die Restzeit zeigen kann.
        if (uhr) clearInterval(uhr);
        let rest = d.sekunden ?? 300;
        useStore.setState((s) => ({ update: { ...s.update, zustand: 'bereit', restSekunden: rest, verschoben: false } }));
        uhr = setInterval(() => {
          rest -= 1;
          if (rest <= 0) { clearInterval(uhr!); uhr = null; return; }
          useStore.setState((s) => ({ update: { ...s.update, restSekunden: rest } }));
        }, 1000);
        break;
      }
      case 'postponed':
        if (uhr) { clearInterval(uhr); uhr = null; }
        useStore.setState((s) => ({ update: { ...s.update, restSekunden: undefined, verschoben: true } }));
        break;
      case 'installing':
        useStore.setState({ update: { zustand: 'installiert', version: d.version } });
        break;
      case 'none':
        useStore.setState({ update: { zustand: 'aktuell', version: d.version } });
        break;
      case 'error':
        if (uhr) { clearInterval(uhr); uhr = null; }
        useStore.setState({ update: { zustand: 'fehler', fehler: d.message } });
        break;
    }
  });
}
