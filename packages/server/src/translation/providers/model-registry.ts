import { ProviderError } from './types.js';

/**
 * Fragt die Modell-Liste des Anbieters ab und wählt selbst aus, statt feste
 * IDs in der Konfiguration zu halten. Groq benennt Modelle regelmäßig um oder
 * nimmt sie aus dem Programm — eine fest eingetragene ID ist irgendwann tot.
 *
 * Gewählt werden zwei Modelle:
 *   quality  für Übersetzung und Zusammenfassungen (das größte brauchbare)
 *   fast     für Smart Replies und kurze Aufgaben (das kleinste brauchbare)
 */

export interface DiscoveredModel {
  id: string;
  contextWindow: number;
  maxCompletionTokens: number | null;
  ownedBy: string;
  /** Geschätzte Parameterzahl in Milliarden, aus der ID gelesen. */
  params: number | null;
  score: number;
  /** Warum das Modell aussortiert wurde — null heißt: brauchbar. */
  rejected: string | null;
}

export interface ModelSelection {
  quality: string;
  fast: string;
  /** 'auto' = von der API gewählt, 'pinned' = per .env festgelegt,
   *  'manual' = in den Einstellungen gewählt,
   *  'fallback' = API nicht erreichbar, bekannte Standardwerte. */
  source: 'auto' | 'pinned' | 'manual' | 'fallback';
  refreshedAt: number;
}

/* ── Aussortieren ─────────────────────────────────────────────── */

/** Modelle, die keine Chat-Completions beantworten. */
const NOT_CHAT = [
  { re: /whisper/i,                    why: 'Spracherkennung' },
  { re: /\btts\b|playai-tts|orpheus/i, why: 'Sprachsynthese' },
  { re: /guard|safeguard/i,            why: 'Sicherheits-Klassifikator' },
  { re: /embed/i,                      why: 'Embeddings' },
  { re: /moderation/i,                 why: 'Moderation' },
  { re: /rerank/i,                     why: 'Reranking' },
];

/**
 * Unter diesem Kontextfenster ist ein Modell für uns nutzlos: wir schicken den
 * Gesprächskontext, das Glossar und bei Zusammenfassungen Hunderte Nachrichten
 * mit. 4k reicht dafür nicht. Nebeneffekt: Spezialmodelle mit winzigem Fenster
 * fallen automatisch raus, ohne dass wir sie namentlich kennen müssen.
 */
const MIN_CONTEXT = 8192;

/**
 * Agentische Systeme (Groqs "compound") bauen Werkzeugaufrufe und Websuche ein.
 * Für eine Übersetzung, die exakt ein JSON-Objekt zurückgeben soll, ist das
 * unnötige Unsicherheit — nicht ausgeschlossen, aber nachrangig.
 */
const AGENTIC = /compound|agent/i;

/**
 * Breit einsetzbare Modellfamilien, die zuverlässig mehrsprachig arbeiten und
 * sauberes JSON liefern. Sie bekommen einen Bonus — ausgeschlossen wird nichts,
 * sonst wäre die Auswahl wieder eine fest verdrahtete Liste.
 *
 * Wichtig beim Schnellmodell: ohne diese Einschränkung gewinnt dort das
 * kleinste Modell überhaupt, und das war in Groqs Liste zeitweise ein auf
 * Arabisch spezialisiertes 7B — für deutsche Antwortvorschläge unbrauchbar.
 */
const TRUSTED = /llama|qwen|gpt-oss|kimi|gemma|mixtral|mistral|ministral|phi|deepseek/i;

/** Modelle, die ihre Gedankenkette mit ausgeben — für strenges JSON heikel. */
const REASONING = /-r1-|reasoning|thinking|\bqwq\b/i;

const PREVIEW = /preview|deprecated|alpha|beta/i;

/* ── Größe aus der ID lesen ───────────────────────────────────── */

/**
 * "llama-3.3-70b-versatile" -> 70, "mixtral-8x7b-32768" -> 56,
 * "gpt-oss-120b" -> 120. Modelle ohne Größe im Namen (z.B. "kimi-k2")
 * liefern null und werden über das Kontextfenster eingeordnet.
 */
export function parseParams(id: string): number | null {
  const moe = /(\d+)\s*x\s*(\d+(?:\.\d+)?)\s*b(?![a-z0-9])/i.exec(id);
  if (moe) return Number(moe[1]) * Number(moe[2]);
  const dense = /(?:^|[^a-z0-9.])(\d+(?:\.\d+)?)\s*b(?![a-z0-9])/i.exec(id);
  return dense ? Number(dense[1]) : null;
}

/* ── Bewertung ────────────────────────────────────────────────── */

function evaluate(raw: any): DiscoveredModel {
  const id = String(raw?.id ?? '');
  const contextWindow = Number(raw?.context_window) || 8192;
  const maxCompletionTokens = Number(raw?.max_completion_tokens) || null;
  const params = parseParams(id);

  let rejected: string | null = null;
  if (!id) rejected = 'ohne ID';
  else if (raw?.active === false) rejected = 'abgeschaltet';
  else {
    for (const { re, why } of NOT_CHAT) {
      if (re.test(id)) { rejected = why; break; }
    }
    if (!rejected && contextWindow < MIN_CONTEXT) {
      rejected = `Kontextfenster zu klein (${contextWindow})`;
    }
  }

  // Größe zählt am stärksten, Kontextfenster als Nebenkriterium.
  let score = params ?? 30;
  score += Math.log2(Math.max(contextWindow, 4096) / 8192) * 4;
  if (TRUSTED.test(id)) score += 12;
  if (REASONING.test(id)) score -= 18;
  if (PREVIEW.test(id)) score -= 14;
  if (AGENTIC.test(id)) score -= 10;

  return {
    id, contextWindow, maxCompletionTokens,
    ownedBy: String(raw?.owned_by ?? 'unbekannt'),
    params, score, rejected,
  };
}

/* ── Registry ─────────────────────────────────────────────────── */

export interface RegistryOptions {
  name: string;
  baseUrl: string;
  apiKey: string;
  /** Aus der .env — gesetzt heißt: nicht automatisch wählen. */
  pinnedQuality?: string;
  pinnedFast?: string;
  /** Greift, solange die API nicht geantwortet hat. */
  fallbackQuality: string;
  fallbackFast: string;
  timeoutMs?: number;
  /** Dienste im eigenen Netz brauchen keinen Schlüssel. */
  ohneSchluessel?: boolean;
  /**
   * Liste unbewertet übernehmen.
   *
   * Die Bewertung ist auf die Namen der großen Anbieter zugeschnitten — sie
   * liest die Parameterzahl aus "llama-3.1-8b-instant" heraus. Bei einem
   * lokalen Dienst steht dort, was jemand geladen hat ("gemma3:4b"), und eine
   * Bewertung würde eher aussortieren als helfen. Genommen wird dann die
   * Reihenfolge, in der der Dienst die Modelle nennt.
   */
  unbewertet?: boolean;
}

export class ModelRegistry {
  private models: DiscoveredModel[] = [];
  private selection: ModelSelection;
  /** Modelle, die im Betrieb Fehler geworfen haben. */
  private broken = new Set<string>();
  /** Von Hand in den Einstellungen gewählt — schlägt die Automatik. */
  private manual: { quality: string | null; fast: string | null } = { quality: null, fast: null };
  private timer: NodeJS.Timeout | null = null;
  private inflight: Promise<void> | null = null;

  constructor(private readonly opts: RegistryOptions) {
    const pinned = Boolean(opts.pinnedQuality && opts.pinnedFast);
    this.selection = {
      quality: opts.pinnedQuality || opts.fallbackQuality,
      fast: opts.pinnedFast || opts.fallbackFast,
      source: pinned ? 'pinned' : 'fallback',
      refreshedAt: 0,
    };
  }

  get current(): ModelSelection { return this.selection; }
  get discovered(): DiscoveredModel[] { return this.models; }

  /**
   * Wie viel dieses Modell überhaupt entgegennimmt.
   *
   * Die Zahl steht in der Modell-Liste — Groq nennt sie, llama.cpp und Ollama
   * nennen sie mal so, mal gar nicht. Fehlt sie, gilt `MIN_CONTEXT`, und das
   * ist bewusst die kleinste Zahl, mit der wir ein Modell überhaupt nehmen
   * würden: lieber zu wenig annehmen und kürzen als zu viel schicken.
   *
   * Warum wir das überhaupt wissen wollen, statt beim Modell „mach das Fenster
   * größer" zu bestellen: das Modell läuft auf einem fremden Rechner. Dessen
   * Einstellungen gehören uns nicht, und beim nächsten Modell ist die Zahl
   * wieder eine andere. Hineinpassen müssen wir.
   */
  kontextfenster(modelId?: string): number {
    const id = modelId || this.selection.quality;
    const treffer = this.models.find((m) => m.id === id);
    return treffer?.contextWindow || MIN_CONTEXT;
  }
  get usable(): DiscoveredModel[] {
    return this.models.filter((m) => !m.rejected && !this.broken.has(m.id));
  }

  /** Beide IDs festgenagelt? Dann gibt es nichts zu entdecken. */
  private get fullyPinned(): boolean {
    return Boolean(this.opts.pinnedQuality && this.opts.pinnedFast);
  }

  async refresh(): Promise<void> {
    if (this.fullyPinned) return;
    if (!this.opts.apiKey && !this.opts.ohneSchluessel) return;
    if (this.inflight) return this.inflight;
    this.inflight = this.doRefresh().finally(() => { this.inflight = null; });
    return this.inflight;
  }

  private async doRefresh(): Promise<void> {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), this.opts.timeoutMs ?? 10_000);
    try {
      const res = await fetch(`${this.opts.baseUrl}/models`, {
        headers: this.opts.apiKey ? { authorization: `Bearer ${this.opts.apiKey}` } : {},
        signal: ctrl.signal,
      });
      if (!res.ok) {
        throw new ProviderError(`${this.opts.name}/models ${res.status}: ${(await res.text()).slice(0, 200)}`, res.status);
      }
      const body = await res.json() as { data?: unknown[] };
      const list = Array.isArray(body.data) ? body.data : [];
      if (!list.length) throw new ProviderError(`${this.opts.name}: Modell-Liste ist leer`);

      this.models = this.opts.unbewertet
        ? list.map((eintrag) => ({ ...evaluate(eintrag), rejected: null, score: 0 }))
        : list.map(evaluate).sort((a, b) => b.score - a.score);
      this.select();
    } catch (err) {
      // Nicht schlimm: die vorherige Auswahl bleibt gültig.
      console.warn(`[ai] Modell-Liste von ${this.opts.name} nicht abrufbar (${(err as Error).message}) — bleibe bei ${this.selection.quality}`);
    } finally {
      clearTimeout(timer);
    }
  }

  /**
   * Wahl aus den Einstellungen übernehmen. Beide Werte null bedeutet:
   * zurück zur automatischen Auswahl.
   */
  applyManualChoice(quality: string | null, fast: string | null): void {
    this.manual = { quality: quality || null, fast: fast || null };
    this.select();
  }

  private select(): void {
    const usable = this.usable;

    // Von Hand gewählt: gilt, auch wenn die Liste gerade nicht abrufbar ist.
    if (this.manual.quality || this.manual.fast) {
      /*
       * ES SEI DENN, der Dienst kennt das gewählte Modell nachweislich nicht.
       *
       * Bei einem eigenen Modellserver wird das Modell ausgetauscht, indem
       * eine andere Datei geladen wird — danach heisst es anders. Die Wahl in
       * den Einstellungen zeigt dann auf einen Namen, den es nicht mehr gibt,
       * und JEDE Anfrage scheitert mit 400. Das ist kein Randfall, sondern
       * der normale Weg, ein Modell zu wechseln.
       *
       * `usable.length > 0` ist die Bedingung, die das sicher macht: nur wenn
       * eine Liste WIRKLICH vorliegt, darf aus ihrer Abwesenheit auf ein
       * fehlendes Modell geschlossen werden. Ist der Dienst gerade nicht
       * erreichbar, ist die Liste leer, und dann bleibt die Wahl stehen — ein
       * abgeschalteter Rechner darf keine Einstellung überschreiben.
       */
      const kennt = (name: string | null) => !name || usable.some((m) => m.id === name);
      if (!usable.length || (kennt(this.manual.quality) && kennt(this.manual.fast))) {
        const quality = this.manual.quality || this.selection.quality;
        this.selection = {
          quality,
          fast: this.manual.fast || quality,
          source: 'manual',
          refreshedAt: Date.now(),
        };
        return;
      }
      console.warn(
        `[ai] ${this.opts.name} kennt "${this.manual.quality ?? this.manual.fast}" nicht mehr`
        + ` — nehme "${usable[0].id}" aus der Liste. Die Wahl in den Einstellungen`
        + ' zeigt auf ein Modell, das dort nicht mehr geladen ist.',
      );
      /* Die Wahl NICHT löschen: sie gehört dem Menschen, der sie getroffen
         hat. Wird das alte Modell wieder geladen, gilt sie sofort weiter. */
    }

    if (!usable.length) return;

    const quality = this.opts.pinnedQuality || usable[0].id;

    /* Unbewertet: es gibt keine Parameterzahlen, nach denen sich ein
       Schnellmodell aussuchen ließe. Dasselbe Modell für beides ist bei einem
       lokalen Dienst ohnehin der Normalfall — geladen ist meist genau eines. */
    if (this.opts.unbewertet) {
      const fast = this.opts.pinnedFast
        || usable.find((m) => /1b|2b|3b|4b|mini|small|tiny/i.test(m.id))?.id
        || quality;
      this.selection = { quality, fast, source: this.opts.pinnedQuality ? 'pinned' : 'auto', refreshedAt: Date.now() };
      return;
    }

    // Schnellmodell: das kleinste, das noch etwas taugt. Unter 3 Mrd.
    // Parametern wird die Qualität für Antwortvorschläge zu dünn, über 30 Mrd.
    // ist es kein Schnellmodell mehr.
    const bySize = (a: DiscoveredModel, b: DiscoveredModel) =>
      (a.params! - b.params!) || (b.contextWindow - a.contextWindow);

    const small = usable.filter((m) => m.params !== null && m.params >= 3 && m.params <= 30);
    // Erst unter den breit einsetzbaren suchen — sonst gewinnt hier ein
    // Spezialmodell nur deshalb, weil es das kleinste ist.
    const preferred = small.filter((m) => TRUSTED.test(m.id) && !AGENTIC.test(m.id)).sort(bySize);
    const fallback = small.sort(bySize);

    const fast = this.opts.pinnedFast
      || preferred.find((m) => /instant|flash|mini|lite/i.test(m.id))?.id
      || preferred[0]?.id
      || fallback[0]?.id
      || quality;

    const source: ModelSelection['source'] =
      this.opts.pinnedQuality && this.opts.pinnedFast ? 'pinned' : 'auto';

    this.selection = { quality, fast, source, refreshedAt: Date.now() };
  }

  /**
   * Ein Modell hat im Betrieb versagt und wir haben (noch) keine Liste, aus der
   * wir ein anderes wählen könnten — etwa weil der Start ohne Netz lief und der
   * Notnagel-Name bei diesem Konto nicht existiert. Dann Liste holen und neu
   * wählen, statt endlos gegen dieselbe Wand zu laufen.
   */
  async recoverFrom(modelId: string): Promise<boolean> {
    const hatteListe = this.models.length > 0;
    this.markBroken(modelId);
    if (hatteListe) return this.selection.quality !== modelId;

    await this.refresh();
    // Nach dem Abruf noch einmal aussortieren, falls das kaputte Modell in der
    // Liste steht.
    this.markBroken(modelId);
    return this.selection.quality !== modelId;
  }

  /**
   * Ein Modell hat im Betrieb versagt (abgeschaltet, kennt kein JSON-Format).
   * Es fliegt raus und die Auswahl wird neu getroffen.
   */
  markBroken(modelId: string): boolean {
    if (!modelId || this.broken.has(modelId)) return false;
    if (this.opts.pinnedQuality === modelId || this.opts.pinnedFast === modelId) {
      console.warn(`[ai] Festgelegtes Modell ${modelId} macht Probleme — bitte GROQ_MODEL in der .env prüfen.`);
      return false;
    }
    this.broken.add(modelId);
    const before = { ...this.selection };
    this.select();
    if (before.quality !== this.selection.quality || before.fast !== this.selection.fast) {
      console.warn(`[ai] ${modelId} aussortiert, nutze jetzt ${this.selection.quality} / ${this.selection.fast}`);
      return true;
    }
    return false;
  }

  /** Regelmäßig nachsehen, ob Groq neue Modelle anbietet. */
  startAutoRefresh(intervalMs = 6 * 3600_000): void {
    if (this.fullyPinned || this.timer) return;
    this.timer = setInterval(() => { void this.refresh(); }, intervalMs);
    this.timer.unref?.();
  }

  stop(): void {
    if (this.timer) { clearInterval(this.timer); this.timer = null; }
  }
}
