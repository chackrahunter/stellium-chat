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
  { re: /whisper/i,               why: 'Spracherkennung' },
  { re: /\btts\b|playai-tts/i,    why: 'Sprachsynthese' },
  { re: /guard/i,                 why: 'Sicherheits-Klassifikator' },
  { re: /embed/i,                 why: 'Embeddings' },
  { re: /moderation/i,            why: 'Moderation' },
  { re: /rerank/i,                why: 'Reranking' },
];

/**
 * Familien, von denen wir wissen, dass sie sauberes JSON liefern.
 * Wir verlangen das in jeder Übersetzungsanfrage, deshalb bekommen sie
 * einen Bonus — ausgeschlossen wird aber nichts, sonst wäre die Auswahl
 * wieder eine fest verdrahtete Liste.
 */
const TRUSTED = /llama|qwen|gpt-oss|kimi|gemma|mixtral|mistral/i;

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
  }

  // Größe zählt am stärksten, Kontextfenster als Nebenkriterium.
  let score = params ?? 30;
  score += Math.log2(Math.max(contextWindow, 4096) / 8192) * 4;
  if (TRUSTED.test(id)) score += 12;
  if (REASONING.test(id)) score -= 18;
  if (PREVIEW.test(id)) score -= 14;

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
  get usable(): DiscoveredModel[] {
    return this.models.filter((m) => !m.rejected && !this.broken.has(m.id));
  }

  /** Beide IDs festgenagelt? Dann gibt es nichts zu entdecken. */
  private get fullyPinned(): boolean {
    return Boolean(this.opts.pinnedQuality && this.opts.pinnedFast);
  }

  async refresh(): Promise<void> {
    if (this.fullyPinned || !this.opts.apiKey) return;
    if (this.inflight) return this.inflight;
    this.inflight = this.doRefresh().finally(() => { this.inflight = null; });
    return this.inflight;
  }

  private async doRefresh(): Promise<void> {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), this.opts.timeoutMs ?? 10_000);
    try {
      const res = await fetch(`${this.opts.baseUrl}/models`, {
        headers: { authorization: `Bearer ${this.opts.apiKey}` },
        signal: ctrl.signal,
      });
      if (!res.ok) {
        throw new ProviderError(`${this.opts.name}/models ${res.status}: ${(await res.text()).slice(0, 200)}`, res.status);
      }
      const body = await res.json() as { data?: unknown[] };
      const list = Array.isArray(body.data) ? body.data : [];
      if (!list.length) throw new ProviderError(`${this.opts.name}: Modell-Liste ist leer`);

      this.models = list.map(evaluate).sort((a, b) => b.score - a.score);
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
      const quality = this.manual.quality || this.selection.quality;
      this.selection = {
        quality,
        fast: this.manual.fast || quality,
        source: 'manual',
        refreshedAt: Date.now(),
      };
      return;
    }

    if (!usable.length) return;

    const quality = this.opts.pinnedQuality || usable[0].id;

    // Schnellmodell: das kleinste, das noch etwas taugt. Unter 3 Mrd.
    // Parametern wird die Qualität für Antwortvorschläge zu dünn.
    const small = usable
      .filter((m) => m.params !== null && m.params >= 3 && m.params <= 25)
      .sort((a, b) => (a.params! - b.params!) || (b.contextWindow - a.contextWindow));

    const fast = this.opts.pinnedFast
      || small.find((m) => /instant|flash|mini|lite/i.test(m.id))?.id
      || small[0]?.id
      || quality;

    const source: ModelSelection['source'] =
      this.opts.pinnedQuality && this.opts.pinnedFast ? 'pinned' : 'auto';

    this.selection = { quality, fast, source, refreshedAt: Date.now() };
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
