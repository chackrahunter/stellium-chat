/**
 * Maskierung: Alles, was eine Übersetzung kaputtmachen würde, wird vor dem
 * Übersetzen durch Platzhalter ersetzt und danach wieder eingesetzt.
 * Betrifft Codeblöcke, Inline-Code, URLs, @Mentions, #Kanäle, :emoji:
 * und geschützte Glossar-Begriffe.
 */

export interface MaskResult {
  masked: string;
  tokens: string[];
}

const PLACEHOLDER = (i: number) => `{{${i}}}`;
const PLACEHOLDER_RE = /\{\{\s*(\d+)\s*\}\}/g;

export interface MaskOptions {
  /** Begriffe, die unverändert bleiben müssen (z.B. "Stellium", "Jira"). */
  protectedTerms?: string[];
  protectedCaseSensitive?: boolean;
}

const PATTERNS: RegExp[] = [
  /```[\s\S]*?```/g,               // Codeblock
  /`[^`\n]+`/g,                    // Inline-Code
  /<https?:\/\/[^>\s]+>/g,         // Link in spitzen Klammern
  /\bhttps?:\/\/\S+/g,             // nackte URL
  /\b[\w.+-]+@[\w-]+\.[\w.]+\b/g,  // E-Mail
  /<@[a-zA-Z0-9_-]+>/g,            // aufgelöste Mention
  /(?<![\w])@[a-zA-Z0-9_.-]{2,32}/g, // @handle
  /(?<![\w])#[a-zA-Z0-9_-]{2,48}/g,  // #kanal
  /:[a-z0-9_+-]{2,32}:/g,          // :emoji:
];

export function maskText(text: string, opts: MaskOptions = {}): MaskResult {
  const tokens: string[] = [];
  let out = text;

  const store = (raw: string) => {
    const idx = tokens.length;
    tokens.push(raw);
    return PLACEHOLDER(idx);
  };

  for (const re of PATTERNS) {
    out = out.replace(new RegExp(re.source, re.flags), (m) => store(m));
  }

  const terms = (opts.protectedTerms ?? []).filter((t) => t.trim().length > 1);
  if (terms.length) {
    // längste zuerst, damit "Stellium Cloud" vor "Stellium" greift
    const sorted = [...terms].sort((a, b) => b.length - a.length);
    const flags = opts.protectedCaseSensitive ? 'g' : 'gi';
    for (const term of sorted) {
      const re = new RegExp(`(?<![\\p{L}\\p{N}])${escapeRegExp(term)}(?![\\p{L}\\p{N}])`, flags + 'u');
      out = out.replace(re, (m) => store(m));
    }
  }

  return { masked: out, tokens };
}

export function unmaskText(masked: string, tokens: string[]): string {
  return masked.replace(PLACEHOLDER_RE, (whole, idxRaw) => {
    const idx = Number(idxRaw);
    return Number.isInteger(idx) && idx >= 0 && idx < tokens.length ? tokens[idx] : whole;
  });
}

/** Prüft, ob das Modell alle Platzhalter erhalten hat. */
export function placeholdersIntact(masked: string, translated: string): boolean {
  const want = countPlaceholders(masked);
  const got = countPlaceholders(translated);
  if (want.size !== got.size) return false;
  for (const id of want) if (!got.has(id)) return false;
  return true;
}

function countPlaceholders(s: string): Set<string> {
  const set = new Set<string>();
  for (const m of s.matchAll(PLACEHOLDER_RE)) set.add(m[1]);
  return set;
}

export function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** Wie viel "echter" Text bleibt nach Maskierung übrig? 0 = nichts zu übersetzen. */
export function translatableLength(masked: string): number {
  return masked.replace(PLACEHOLDER_RE, '').replace(/\s+/g, '').length;
}

/** @handle aus einem Text ziehen (für Mention-Benachrichtigungen). */
export function extractMentions(text: string): string[] {
  const out = new Set<string>();
  const stripped = text.replace(/```[\s\S]*?```/g, ' ').replace(/`[^`\n]+`/g, ' ');
  for (const m of stripped.matchAll(/(?<![\w])@([a-zA-Z0-9_.-]{2,32})/g)) out.add(m[1].toLowerCase());
  return [...out];
}
