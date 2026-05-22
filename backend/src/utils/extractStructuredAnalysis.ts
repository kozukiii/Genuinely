// ─── Types ────────────────────────────────────────────────────────────────────

export type ParsedAnalysis = {
  scores?: Record<string, number | null>;
  overview?: string;
  highlights?: { label: string; positive: boolean }[];
};

// ─── Constants ────────────────────────────────────────────────────────────────

/** Returned when AI output cannot be parsed or is fully invalid. */
export const EMPTY_ANALYSIS: Readonly<{
  aiScore: null;
  aiScores: Record<string, never>;
  overview: string;
  highlights: never[];
}> = {
  aiScore: null,
  aiScores: {},
  overview: "No overview.",
  highlights: [],
};

// ─── Score field allow-lists ──────────────────────────────────────────────────

const EBAY_SCORE_KEYS = new Set([
  "priceFairness",
  "conditionHonesty",
  "shippingFairness",
  "descriptionQuality",
]);

const MARKETPLACE_SCORE_KEYS = new Set([
  "priceFairness",
  "sellerTrust",
  "conditionHonesty",
  "shippingFairness",
  "descriptionQuality",
]);

// Fields where null is permitted (Marketplace priceFairness for Accepts Offers)
const NULLABLE_SCORE_KEYS = new Set(["priceFairness"]);

// ─── Validation helpers ───────────────────────────────────────────────────────

function clampScore(value: unknown, key: string): number | null {
  if (value === null && NULLABLE_SCORE_KEYS.has(key)) return null;

  // Accept string numbers like "90" that the model sometimes emits
  const n = typeof value === "string" ? parseFloat(value) : Number(value);

  if (!Number.isFinite(n)) {
    console.warn(`[validateAnalysis] score "${key}" is not a finite number (got ${JSON.stringify(value)}) — dropping`);
    return null;
  }

  if (n < 0 || n > 100) {
    console.warn(`[validateAnalysis] score "${key}" out of range (${n}) — clamping to 0–100`);
    return Math.max(0, Math.min(100, Math.round(n)));
  }

  return Math.round(n);
}

function validateHighlights(raw: unknown): { label: string; positive: boolean }[] {
  if (!Array.isArray(raw)) return [];

  const MAX_HIGHLIGHTS = 6;
  const valid: { label: string; positive: boolean }[] = [];

  for (const item of raw) {
    if (!item || typeof item !== "object" || Array.isArray(item)) continue;
    const label = (item as any).label;
    const positive = (item as any).positive;
    if (typeof label !== "string" || !label.trim()) continue;
    if (typeof positive !== "boolean") continue;
    valid.push({ label: label.trim(), positive });
    if (valid.length >= MAX_HIGHLIGHTS) break;
  }

  return valid;
}

/**
 * Validate and normalise a parsed AI analysis object.
 *
 * @param raw       - The JS object obtained from JSON.parse
 * @param scoreKeys - Which score keys are expected for this source
 *                    (use EBAY_SCORE_KEYS or MARKETPLACE_SCORE_KEYS)
 * @returns         - A clean ParsedAnalysis with only valid fields, or null if
 *                    the object is so broken that nothing can be salvaged.
 */
export function validateAnalysis(
  raw: unknown,
  scoreKeys: Set<string>,
): ParsedAnalysis | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    console.warn("[validateAnalysis] top-level value is not an object — discarding");
    return null;
  }

  const obj = raw as Record<string, unknown>;

  // ── scores ────────────────────────────────────────────────────────────────
  const rawScores = obj.scores;
  if (!rawScores || typeof rawScores !== "object" || Array.isArray(rawScores)) {
    console.warn("[validateAnalysis] missing or malformed 'scores' object");
    return null;
  }

  const scores: Record<string, number | null> = {};
  let kept = 0;

  for (const key of scoreKeys) {
    const value = (rawScores as Record<string, unknown>)[key];
    if (value === undefined) continue; // field absent — OK, caller handles
    const clamped = clampScore(value, key);
    scores[key] = clamped;
    kept++;
  }

  // Log if the model returned extra fields we don't expect
  for (const key of Object.keys(rawScores as object)) {
    if (!scoreKeys.has(key)) {
      console.warn(`[validateAnalysis] unexpected score key "${key}" — ignored`);
    }
  }

  if (kept === 0) {
    console.warn("[validateAnalysis] no valid score fields found");
    return null;
  }

  // ── overview ──────────────────────────────────────────────────────────────
  const rawOverview = obj.overview;
  let overview: string | undefined;

  if (typeof rawOverview === "string") {
    const trimmed = rawOverview.trim().split(/\bDEBUG INFO:\b/i)[0]?.trim() ?? "";
    overview = trimmed || undefined;
  }

  if (!overview) {
    console.warn("[validateAnalysis] overview missing or empty — will use fallback");
  }

  // ── highlights ────────────────────────────────────────────────────────────
  const highlights = validateHighlights(obj.highlights);

  return { scores, overview, highlights };
}

// ─── Low-level JSON extraction (kept as defensive backup) ────────────────────

function sanitizeOverview(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  if (!trimmed) return undefined;
  const withoutDebug = trimmed.split(/\bDEBUG INFO:\b/i)[0]?.trim() ?? trimmed;
  return withoutDebug || undefined;
}

function tryParseObject(candidate: string): ParsedAnalysis | null {
  try {
    const parsed = JSON.parse(candidate);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
    return parsed as ParsedAnalysis;
  } catch {
    return null;
  }
}

function extractFirstJsonObject(text: string): ParsedAnalysis | null {
  const start = text.indexOf("{");
  if (start === -1) return null;

  let depth = 0;
  let inString = false;
  let escaped = false;

  for (let i = start; i < text.length; i++) {
    const ch = text[i];

    if (inString) {
      if (escaped) { escaped = false; }
      else if (ch === "\\") { escaped = true; }
      else if (ch === '"') { inString = false; }
      continue;
    }

    if (ch === '"') { inString = true; continue; }
    if (ch === "{") depth++;
    if (ch === "}") {
      depth--;
      if (depth === 0) return tryParseObject(text.slice(start, i + 1));
    }
  }

  return null;
}

/**
 * Extract a ParsedAnalysis from a raw model response string.
 *
 * Tries three strategies in order:
 *  1. Parse the whole trimmed string as JSON
 *  2. Strip everything from "DEBUG INFO:" onward, then parse
 *  3. Find the first `{...}` by brace depth and parse that
 *
 * Returns null if nothing parseable is found.
 */
export function extractStructuredAnalysis(analysis: string): ParsedAnalysis | null {
  const trimmed = analysis.trim();

  const whole = tryParseObject(trimmed);
  if (whole) {
    return { ...whole, overview: sanitizeOverview(whole.overview) };
  }

  const beforeDebug = trimmed.split(/\bDEBUG INFO:\b/i)[0]?.trim() ?? trimmed;
  const beforeDebugParsed = tryParseObject(beforeDebug);
  if (beforeDebugParsed) {
    return { ...beforeDebugParsed, overview: sanitizeOverview(beforeDebugParsed.overview) };
  }

  const firstObject = extractFirstJsonObject(trimmed);
  if (!firstObject) return null;

  return { ...firstObject, overview: sanitizeOverview(firstObject.overview) };
}
