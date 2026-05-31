import { createHmac, timingSafeEqual } from "crypto";

const LISTING_PROOF_TTL_MS = 15 * 60 * 1000;

const DERIVED_FIELDS = new Set([
  "analysisProof",
  "analysisPending",
  "analysisSkipped",
  "analyzedAt",
  "aiScore",
  "aiScores",
  "availabilityCheckedAt",
  "availabilityReason",
  "availabilityStatus",
  "debugInfo",
  "endedAt",
  "highlights",
  "lastSeenActiveAt",
  "marketContext",
  "overview",
  "priceChartingUrl",
  "priceHigh",
  "priceLow",
  "priceSource",
  "rawAnalysis",
  "shippingEstimated",
  "systemPrompt",
  "tcgPlayerUrl",
]);

export interface ListingAnalysisProof {
  expiresAt: number;
  signature: string;
}

function getSigningSecret(): string {
  const secret = process.env.ANALYSIS_SIGNING_SECRET ?? process.env.JWT_SECRET;
  if (secret) return secret;
  if (process.env.NODE_ENV !== "production") return "genuinely-local-analysis-signing-secret";
  throw new Error("ANALYSIS_SIGNING_SECRET or JWT_SECRET must be configured");
}

function stripDerivedFields(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stripDerivedFields);
  if (!value || typeof value !== "object") return value;

  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .filter(([key]) => !DERIVED_FIELDS.has(key))
      .map(([key, nested]) => [key, stripDerivedFields(nested)])
  );
}

function stableStringify(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  if (!value || typeof value !== "object") return JSON.stringify(value);

  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, nested]) => nested !== undefined)
    .sort(([a], [b]) => a.localeCompare(b));

  return `{${entries.map(([key, nested]) => `${JSON.stringify(key)}:${stableStringify(nested)}`).join(",")}}`;
}

function signatureFor(listing: unknown, expiresAt: number): string {
  const canonical = stableStringify(stripDerivedFields(listing));
  return createHmac("sha256", getSigningSecret())
    .update(`${expiresAt}.${canonical}`)
    .digest("base64url");
}

export function signListingForAnalysis<T extends Record<string, any>>(listing: T): T & { analysisProof: ListingAnalysisProof } {
  const expiresAt = Date.now() + LISTING_PROOF_TTL_MS;
  return {
    ...listing,
    analysisProof: {
      expiresAt,
      signature: signatureFor(listing, expiresAt),
    },
  };
}

export function verifyListingForAnalysis(listing: unknown): Record<string, any> | null {
  if (!listing || typeof listing !== "object" || Array.isArray(listing)) return null;

  const proof = (listing as Record<string, any>).analysisProof as ListingAnalysisProof | undefined;
  if (!proof || !Number.isFinite(proof.expiresAt) || proof.expiresAt <= Date.now() || typeof proof.signature !== "string") {
    return null;
  }

  const expected = Buffer.from(signatureFor(listing, proof.expiresAt));
  const actual = Buffer.from(proof.signature);
  if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) return null;

  return stripDerivedFields(listing) as Record<string, any>;
}

export function analysisListingKey(listing: Record<string, any>): string {
  return `${listing.source}:${listing.id}`;
}
