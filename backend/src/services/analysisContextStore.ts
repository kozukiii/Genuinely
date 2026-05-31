import { randomUUID } from "crypto";

const CONTEXT_TTL_MS = 60 * 1000;

export interface TrustedAnalysisContext {
  systemPrompt: string | null;
  priceLow: number | null;
  priceHigh: number | null;
  priceSource: string | null;
  priceChartingUrl: string | null;
  tcgPlayerUrl: string | null;
  shippingEstimate: number | null;
  listingKeys: string[];
}

interface StoredAnalysisContext {
  expiresAt: number;
  value: TrustedAnalysisContext;
}

const contexts = new Map<string, StoredAnalysisContext>();

function pruneExpiredContexts(now = Date.now()) {
  for (const [token, context] of contexts) {
    if (context.expiresAt <= now) contexts.delete(token);
  }
}

export function issueAnalysisContext(value: TrustedAnalysisContext): string {
  pruneExpiredContexts();
  const token = randomUUID();
  contexts.set(token, {
    expiresAt: Date.now() + CONTEXT_TTL_MS,
    value,
  });
  return token;
}

export function consumeAnalysisContext(token: unknown, listingKeys: string[]): TrustedAnalysisContext | null {
  if (typeof token !== "string" || !token) return null;

  const stored = contexts.get(token);
  if (!stored) return null;

  if (stored.expiresAt <= Date.now()) {
    contexts.delete(token);
    return null;
  }

  const expectedKeys = [...stored.value.listingKeys].sort();
  const actualKeys = [...listingKeys].sort();
  if (expectedKeys.length !== actualKeys.length || expectedKeys.some((key, index) => key !== actualKeys[index])) {
    return null;
  }

  contexts.delete(token);
  return stored.value;
}
