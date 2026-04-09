import OpenAI from "openai";
import dotenv from "dotenv";
import { fetchMarketContext } from "./priceContext";

dotenv.config({ quiet: true });

const client = new OpenAI({
  apiKey: process.env.GROQ_API_KEY!,
  baseURL: "https://api.groq.com/openai/v1",
});

// ─── Types ────────────────────────────────────────────────────────────────────

export interface ProductGroup {
  canonicalName: string;
  specificity: "specific" | "broad" | "outlier";
  indices: number[];
  systemPrompt: string | null; // fully generated product-expert system prompt
  priceLow: number | null;
  priceHigh: number | null;
}

interface RawGroup {
  canonicalName: string;
  specificity: "specific" | "broad" | "outlier";
  indices: number[];
  tavilyQuery: string;
}

// ─── Step 1: grouping prompt ──────────────────────────────────────────────────

const GROUPING_SYSTEM_PROMPT = `
You are a product classification specialist for a secondhand marketplace search tool.

TASK:
Given a list of listing titles from a search query, group them by exact product.
Generate a targeted web search query per group to find current used market pricing.

GROUPING RULES:
- Only group listings you are CERTAIN are the exact same product — same brand, same model, same variant.
- When in doubt, give each listing its own group. Never merge items speculatively.
- Different storage tiers are different products (128GB ≠ 256GB).
- Different loft or shaft specs are different products (9° driver ≠ 10.5° driver).
- Different club types are always different products (driver ≠ 3 wood, even same series).
- Different generations are different products (iPhone 14 ≠ iPhone 15).
- A listing missing key specs (e.g. no storage size, no loft) cannot be grouped with one that has them — treat it as its own group.
- Canonical name must be as specific as the listing allows (e.g. "Ping G440 Max Driver 9°", "iPhone 14 Pro 256GB Space Black").
- Classify each group:
  - "specific" — exact brand + model + variant is clear (e.g. "Ping G440 Max Driver 10.5°", "iPhone 14 Pro 256GB")
  - "broad"    — product type is clear but key specs are missing or ambiguous (e.g. "golf driver", "used iPhone")
  - "outlier"  — vague, junk, unrelated, or impossible to classify
- Max 8 groups — any excess listings beyond 8 groups go into "outlier".

TAVILY QUERY RULES:
- Make each tavilyQuery exact and specific to the product and variant
- Always include pricing intent (e.g. "used resale price 2025")
- Do NOT use vague phrases like "secondhand item" or "marketplace listing"

OUTPUT FORMAT — return ONLY a JSON array (no markdown, no backticks):
[
  {
    "canonicalName": "Ping G440 Max Driver 10.5°",
    "specificity": "specific",
    "indices": [0, 3],
    "tavilyQuery": "Ping G440 Max Driver 10.5 degree used resale price 2025"
  }
]
`.trim();

// ─── Step 3: prompt generation ────────────────────────────────────────────────

const PROMPT_GENERATION_SYSTEM = `
You are a product expert writing a scoring brief for an AI analyst evaluating secondhand marketplace listings.

You will be given a product name and live market data from a web search.
Write a system prompt that turns the analyst into a genuine domain expert on that exact product.

THE PROMPT MUST:
1. Open with: "You are an expert on [exact product name and any key variants]."
2. State the current used market value range — anchor to the market data, or your own knowledge if data is sparse
3. Name 3–5 specific physical inspection points — real failure modes, known wear locations, damage patterns for this exact product
4. Name 2–3 accessories or extras that affect resale value (headcovers, original box, cables, cases, etc.) and note impact if missing
5. Name 2–4 red flags: seller misrepresentations, hidden defects, or scam signals specific to this product
6. Close with per-score guidance in exactly this structure (no headers, inline):
   PRICE FAIRNESS: [how to anchor the score to the stated market range — any listing priced at the low end of or below the typical used market range must score at minimum 80, scaling upward the further below market it is; listings at or above market price should be scored strictly on value relative to condition and included extras]
   CONDITION HONESTY: [what images and title must show to trust the stated condition]
   DESCRIPTION QUALITY: [what a complete, honest listing for this product includes]

RULES:
- Be specific to this exact product — use real model names, real known defects, real pricing
- Write in second person ("You are an expert…", "Watch for…", "Check whether…")
- Do NOT use generic language like "similar items", "this category", or "this type of product"
- If market data is sparse, draw on your own product knowledge — do not say "data unavailable"
- Return ONLY valid JSON (no markdown, no backticks) in exactly this shape:
  { "priceLow": <number>, "priceHigh": <number>, "systemPrompt": "<the full prompt text>" }
- priceLow and priceHigh must be integers in USD representing the typical used market range
`.trim();

// ─── JSON sanitizer ───────────────────────────────────────────────────────────
// LLMs often embed literal newlines/tabs inside JSON string values, which is
// invalid JSON. This finds every "..." region and escapes bare control chars.
function sanitizeJsonStrings(raw: string): string {
  return raw.replace(/"(?:[^"\\]|\\.)*"/gs, (match) =>
    match
      .replace(/\t/g, "\\t")
      .replace(/\n/g, "\\n")
      .replace(/\r/g, "\\r")
      .replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g, (c) =>
        `\\u${c.charCodeAt(0).toString(16).padStart(4, "0")}`
      )
  );
}

function parsePromptJson(raw: string): { priceLow: number | null; priceHigh: number | null; systemPrompt: string | null } {
  // Strip markdown fences if present
  const stripped = raw.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "").trim();

  for (const attempt of [stripped, sanitizeJsonStrings(stripped)]) {
    try {
      const parsed = JSON.parse(attempt);
      return {
        priceLow:     typeof parsed.priceLow     === "number" ? parsed.priceLow     : null,
        priceHigh:    typeof parsed.priceHigh    === "number" ? parsed.priceHigh    : null,
        systemPrompt: typeof parsed.systemPrompt === "string" ? parsed.systemPrompt : null,
      };
    } catch {}
  }

  // Last resort: pull numbers out with regex (systemPrompt lost, but prices survive)
  const low  = stripped.match(/"priceLow"\s*:\s*(\d+)/)?.[1];
  const high = stripped.match(/"priceHigh"\s*:\s*(\d+)/)?.[1];
  return {
    priceLow:     low  ? parseInt(low,  10) : null,
    priceHigh:    high ? parseInt(high, 10) : null,
    systemPrompt: null,
  };
}

// ─── Main export ──────────────────────────────────────────────────────────────

export async function groupAndContextualize(
  titles: string[],
  query: string,
): Promise<ProductGroup[]> {
  if (titles.length === 0) return [];

  // ── Step 1: group titles ──────────────────────────────────────────────────
  let rawGroups: RawGroup[];

  try {
    const titlesBlock = titles.map((t, i) => `${i}. ${t}`).join("\n");

    const response = await client.chat.completions.create({
      model: "meta-llama/llama-4-scout-17b-16e-instruct",
      messages: [
        { role: "system", content: GROUPING_SYSTEM_PROMPT },
        {
          role: "user",
          content: `Search query: "${query}"\n\nListing titles:\n${titlesBlock}`,
        },
      ],
      max_tokens: 1200,
      temperature: 0.1,
    });

    const raw = (response.choices[0].message.content?.trim() ?? "[]")
      .replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "").trim();
    const parsed = JSON.parse(sanitizeJsonStrings(raw));
    if (!Array.isArray(parsed)) throw new Error("Expected JSON array");

    rawGroups = parsed
      .filter(
        (g: any) =>
          typeof g.canonicalName === "string" &&
          Array.isArray(g.indices) &&
          typeof g.tavilyQuery === "string",
      )
      .map((g: any): RawGroup => ({
        canonicalName: g.canonicalName,
        specificity: (["specific", "broad", "outlier"].includes(g.specificity)
          ? g.specificity
          : "broad") as RawGroup["specificity"],
        indices: (g.indices as any[]).filter((i) => typeof i === "number"),
        tavilyQuery: g.tavilyQuery,
      }));

    if (rawGroups.length === 0) throw new Error("No valid groups returned");
  } catch (err) {
    console.error("[listingContext] grouping LLM failed — falling back:", err);
    rawGroups = [
      {
        canonicalName: query,
        specificity: "broad",
        indices: titles.map((_, i) => i),
        tavilyQuery: `${query} used price resale 2025`,
      },
    ];
  }

  // ── Steps 2 + 3: Tavily then prompt generation, per group in parallel ─────
  const withPrompts: ProductGroup[] = await Promise.all(
    rawGroups.map(async (group): Promise<ProductGroup> => {
      if (group.specificity === "outlier") {
        return { canonicalName: group.canonicalName, specificity: "outlier", indices: group.indices, systemPrompt: null, priceLow: null, priceHigh: null };
      }

      // Step 2: Tavily market data
      const marketData = await fetchMarketContext(group.tavilyQuery).catch(() => null);

      // Step 3: context LLM writes the product-expert system prompt
      try {
        const userContent = [
          `Product: ${group.canonicalName}`,
          "",
          "Market data from web search:",
          marketData ?? "No market data returned — draw on your own product knowledge.",
        ].join("\n");

        const promptResponse = await client.chat.completions.create({
          model: "meta-llama/llama-4-scout-17b-16e-instruct",
          messages: [
            { role: "system", content: PROMPT_GENERATION_SYSTEM },
            { role: "user", content: userContent },
          ],
          max_tokens: 700,
          temperature: 0.25,
        });

        const raw = promptResponse.choices[0].message.content?.trim() ?? "{}";
        const { systemPrompt, priceLow, priceHigh } = parsePromptJson(raw);
        return { canonicalName: group.canonicalName, specificity: group.specificity, indices: group.indices, systemPrompt, priceLow, priceHigh };
      } catch (err) {
        console.error(`[listingContext] prompt generation failed for "${group.canonicalName}":`, err);
        return { canonicalName: group.canonicalName, specificity: group.specificity, indices: group.indices, systemPrompt: null, priceLow: null, priceHigh: null };
      }
    }),
  );

  return withPrompts;
}
