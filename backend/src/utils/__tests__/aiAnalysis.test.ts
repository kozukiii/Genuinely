import { describe, it, expect } from "vitest";
import {
  extractStructuredAnalysis,
  validateAnalysis,
  EMPTY_ANALYSIS,
  type ParsedAnalysis,
} from "../extractStructuredAnalysis";
import { extractBatchObjects } from "../extractBatchObjects";

// ─── Score key sets (mirrors production code) ─────────────────────────────────

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

// ─── Helper ───────────────────────────────────────────────────────────────────

function validEbayPayload(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    scores: {
      priceFairness: 75,
      conditionHonesty: 80,
      shippingFairness: 90,
      descriptionQuality: 70,
    },
    overview: "This is a clean listing with good photos.",
    highlights: [
      { label: "Free shipping", positive: true },
      { label: "Minor scratches", positive: false },
    ],
    ...overrides,
  });
}

function validMarketplacePayload(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    scores: {
      priceFairness: 85,
      sellerTrust: 75,
      conditionHonesty: 70,
      shippingFairness: 80,
      descriptionQuality: 65,
    },
    overview: "Marketplace listing looks authentic.",
    highlights: [{ label: "Local pickup only", positive: true }],
    ...overrides,
  });
}

// ─── extractStructuredAnalysis ────────────────────────────────────────────────

describe("extractStructuredAnalysis", () => {
  it("parses clean JSON output (JSON Object Mode response)", () => {
    const result = extractStructuredAnalysis(validEbayPayload());
    expect(result).not.toBeNull();
    expect(result?.scores?.priceFairness).toBe(75);
    expect(result?.overview).toBe("This is a clean listing with good photos.");
  });

  it("still works with markdown-fenced JSON (defensive fallback)", () => {
    const fenced = "```json\n" + validEbayPayload() + "\n```";
    const result = extractStructuredAnalysis(fenced);
    expect(result).not.toBeNull();
    expect(result?.scores?.priceFairness).toBe(75);
  });

  it("strips DEBUG INFO: section from single-listing legacy format", () => {
    const withDebug = validEbayPayload() + "\nDEBUG INFO:\nTitle: Foo\nPrice: 99";
    const result = extractStructuredAnalysis(withDebug);
    expect(result).not.toBeNull();
    expect(result?.overview).not.toMatch(/DEBUG INFO/i);
  });

  it("returns null for completely unparseable input", () => {
    expect(extractStructuredAnalysis("This is not JSON at all.")).toBeNull();
    expect(extractStructuredAnalysis("")).toBeNull();
  });

  it("returns a partial object for '{}' — validateAnalysis is what rejects it for missing scores", () => {
    const result = extractStructuredAnalysis("{}");
    expect(result).not.toBeNull();
    // validateAnalysis rejects it because scores is absent
    expect(validateAnalysis(result!, EBAY_SCORE_KEYS)).toBeNull();
  });

  it("finds JSON embedded after preamble text", () => {
    const withPreamble = "Sure, here is the analysis:\n" + validEbayPayload();
    const result = extractStructuredAnalysis(withPreamble);
    expect(result).not.toBeNull();
    expect(result?.scores?.conditionHonesty).toBe(80);
  });
});

// ─── validateAnalysis ─────────────────────────────────────────────────────────

describe("validateAnalysis — eBay score keys", () => {
  it("accepts valid eBay payload and keeps expected keys", () => {
    const raw = JSON.parse(validEbayPayload()) as ParsedAnalysis;
    const result = validateAnalysis(raw, EBAY_SCORE_KEYS);
    expect(result).not.toBeNull();
    expect(Object.keys(result!.scores!).sort()).toEqual(
      ["conditionHonesty", "descriptionQuality", "priceFairness", "shippingFairness"],
    );
  });

  it("eBay sellerTrust is dropped when present in AI output", () => {
    // sellerTrust must NOT be in EBAY_SCORE_KEYS — the caller overwrites it deterministically
    const raw = JSON.parse(validEbayPayload()) as ParsedAnalysis;
    raw.scores = { ...raw.scores, sellerTrust: 99 } as any;
    const result = validateAnalysis(raw, EBAY_SCORE_KEYS);
    expect(result?.scores).not.toHaveProperty("sellerTrust");
  });

  it("clamps scores above 100 to 100", () => {
    const raw = JSON.parse(validEbayPayload()) as ParsedAnalysis;
    raw.scores = { priceFairness: 150, conditionHonesty: 80, shippingFairness: 90, descriptionQuality: 70 };
    const result = validateAnalysis(raw, EBAY_SCORE_KEYS);
    expect(result?.scores?.priceFairness).toBe(100);
  });

  it("clamps scores below 0 to 0", () => {
    const raw = JSON.parse(validEbayPayload()) as ParsedAnalysis;
    raw.scores = { priceFairness: -5, conditionHonesty: 80, shippingFairness: 90, descriptionQuality: 70 };
    const result = validateAnalysis(raw, EBAY_SCORE_KEYS);
    expect(result?.scores?.priceFairness).toBe(0);
  });

  it("accepts string scores like '90' and converts them", () => {
    const raw = JSON.parse(validEbayPayload()) as ParsedAnalysis;
    raw.scores = { priceFairness: "90" as any, conditionHonesty: 80, shippingFairness: 90, descriptionQuality: 70 };
    const result = validateAnalysis(raw, EBAY_SCORE_KEYS);
    expect(result?.scores?.priceFairness).toBe(90);
  });

  it("drops non-numeric string scores instead of crashing", () => {
    const raw = JSON.parse(validEbayPayload()) as ParsedAnalysis;
    raw.scores = { priceFairness: "high" as any, conditionHonesty: 80, shippingFairness: 90, descriptionQuality: 70 };
    const result = validateAnalysis(raw, EBAY_SCORE_KEYS);
    // "high" is not finite — should be dropped (null)
    expect(result?.scores?.priceFairness).toBeNull();
  });

  it("returns null when scores object is missing", () => {
    const raw = { overview: "No scores here.", highlights: [] };
    expect(validateAnalysis(raw, EBAY_SCORE_KEYS)).toBeNull();
  });

  it("returns null when input is not an object", () => {
    expect(validateAnalysis(null, EBAY_SCORE_KEYS)).toBeNull();
    expect(validateAnalysis("string", EBAY_SCORE_KEYS)).toBeNull();
    expect(validateAnalysis([1, 2], EBAY_SCORE_KEYS)).toBeNull();
  });

  it("overview falls back to undefined when empty", () => {
    const raw = JSON.parse(validEbayPayload()) as ParsedAnalysis;
    raw.overview = "   ";
    const result = validateAnalysis(raw, EBAY_SCORE_KEYS);
    expect(result?.overview).toBeUndefined();
  });

  it("sanitises highlights — drops items missing label or positive", () => {
    const raw = JSON.parse(validEbayPayload()) as ParsedAnalysis;
    raw.highlights = [
      { label: "Good highlight", positive: true },
      { label: "", positive: false },         // empty label — drop
      { label: "Missing positive" } as any,   // positive missing — drop
      { positive: true } as any,              // label missing — drop
    ];
    const result = validateAnalysis(raw, EBAY_SCORE_KEYS);
    expect(result?.highlights).toHaveLength(1);
    expect(result?.highlights?.[0].label).toBe("Good highlight");
  });

  it("limits highlights to 6", () => {
    const raw = JSON.parse(validEbayPayload()) as ParsedAnalysis;
    raw.highlights = Array.from({ length: 10 }, (_, i) => ({
      label: `Highlight ${i}`,
      positive: true,
    }));
    const result = validateAnalysis(raw, EBAY_SCORE_KEYS);
    expect(result?.highlights?.length).toBeLessThanOrEqual(6);
  });
});

describe("validateAnalysis — Marketplace score keys", () => {
  it("accepts valid Marketplace payload", () => {
    const raw = JSON.parse(validMarketplacePayload()) as ParsedAnalysis;
    const result = validateAnalysis(raw, MARKETPLACE_SCORE_KEYS);
    expect(result).not.toBeNull();
    expect(result?.scores?.sellerTrust).toBe(75);
  });

  it("allows priceFairness: null for Accepts Offers listings", () => {
    const raw = JSON.parse(
      validMarketplacePayload({ scores: { priceFairness: null, sellerTrust: 75, conditionHonesty: 70, shippingFairness: 80, descriptionQuality: 65 } }),
    ) as ParsedAnalysis;
    const result = validateAnalysis(raw, MARKETPLACE_SCORE_KEYS);
    expect(result?.scores?.priceFairness).toBeNull();
  });

  it("does not allow null on non-nullable fields like conditionHonesty", () => {
    const raw = JSON.parse(validMarketplacePayload()) as ParsedAnalysis;
    raw.scores = { priceFairness: 80, sellerTrust: 75, conditionHonesty: null as any, shippingFairness: 80, descriptionQuality: 65 };
    const result = validateAnalysis(raw, MARKETPLACE_SCORE_KEYS);
    // null on a non-nullable key is not a finite number — should be dropped (null returned from clampScore but with null)
    // Actually looking at the code: NULLABLE_SCORE_KEYS only has "priceFairness", so null on conditionHonesty
    // will go through: value===null but key not in NULLABLE_SCORE_KEYS -> falls through to Number(null)=0 -> finite
    // Wait, let me re-check the clampScore logic:
    // if (value === null && NULLABLE_SCORE_KEYS.has(key)) return null;  <- only for priceFairness
    // Then Number(null) = 0, isFinite(0) = true, so it returns 0 (clamped to 0)
    expect(result?.scores?.conditionHonesty).toBe(0);
  });
});

// ─── EMPTY_ANALYSIS ───────────────────────────────────────────────────────────

describe("EMPTY_ANALYSIS constant", () => {
  it("has the expected shape", () => {
    expect(EMPTY_ANALYSIS.aiScore).toBeNull();
    expect(EMPTY_ANALYSIS.aiScores).toEqual({});
    expect(EMPTY_ANALYSIS.overview).toBe("No overview.");
    expect(EMPTY_ANALYSIS.highlights).toEqual([]);
  });
});

// ─── extractBatchObjects ──────────────────────────────────────────────────────

describe("extractBatchObjects", () => {
  it("extracts objects from a well-formed { listings: [...] } response", () => {
    const input = JSON.stringify({
      listings: [
        { listingIndex: 0, scores: { priceFairness: 80 }, overview: "Good", highlights: [] },
        { listingIndex: 1, scores: { priceFairness: 60 }, overview: "OK",   highlights: [] },
      ],
    });
    // extractBatchObjects finds top-level {...} objects — the outer wrapper plus inner ones
    const result = extractBatchObjects(input);
    // The outer object is the first { ... } found at depth 0
    // It contains the full payload
    expect(result.length).toBeGreaterThanOrEqual(1);
  });

  it("extracts individual objects from a bare array response (legacy fallback)", () => {
    const input = JSON.stringify([
      { listingIndex: 0, scores: { priceFairness: 80 }, overview: "Good", highlights: [] },
      { listingIndex: 1, scores: { priceFairness: 60 }, overview: "OK",   highlights: [] },
    ]);
    const result = extractBatchObjects(input);
    expect(result).toHaveLength(2);
    expect(result[0].listingIndex).toBe(0);
    expect(result[1].listingIndex).toBe(1);
  });

  it("skips objects with literal newlines in string values (repairLiteralNewlines)", () => {
    // Simulate a model that forgot to escape a newline inside a string
    const broken = `[{"listingIndex":0,"overview":"Line one\nLine two","scores":{"priceFairness":70},"highlights":[]}]`;
    const result = extractBatchObjects(broken);
    expect(result).toHaveLength(1);
    // The newline should have been escaped so overview is parseable
    expect(result[0].overview).toContain("Line one");
  });

  it("returns empty array for completely unparseable input", () => {
    expect(extractBatchObjects("not json at all")).toEqual([]);
    expect(extractBatchObjects("")).toEqual([]);
  });

  it("tolerates missing commas between objects", () => {
    // Deliberately malformed — no comma between the two objects
    const missingComma = `[{"listingIndex":0,"scores":{},"overview":"A","highlights":[]}{"listingIndex":1,"scores":{},"overview":"B","highlights":[]}]`;
    const result = extractBatchObjects(missingComma);
    expect(result.length).toBe(2);
  });
});
