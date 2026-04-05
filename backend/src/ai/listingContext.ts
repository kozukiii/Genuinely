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
Given a list of listing titles from a search query, group them by distinct product model.
Generate a targeted web search query per group to find current used market pricing.

GROUPING RULES:
- Group listings that share the same brand + model series
- Canonical name must be specific (e.g. "Ping G440 3 Wood" not "golf club")
- Classify each group:
  - "specific" — clear brand + model (e.g. "Ping G440 3 Wood", "iPhone 14 Pro 256GB")
  - "broad"    — product type only, no clear model (e.g. "3 wood", "used phone")
  - "outlier"  — vague, junk, or unrelated titles
- Merge close variants (colors, minor storage tiers) into one group
- Max 8 groups — combine leftovers into "outlier"

TAVILY QUERY RULES:
- Make each tavilyQuery tight and specific to the exact product
- Always include pricing intent (e.g. "used resale price 2025")
- Do NOT use vague phrases like "secondhand item" or "marketplace listing"

OUTPUT FORMAT — return ONLY a JSON array (no markdown, no backticks):
[
  {
    "canonicalName": "Ping G440 3 Wood",
    "specificity": "specific",
    "indices": [0, 3, 7],
    "tavilyQuery": "Ping G440 3 wood used resale price 2025"
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
- Return ONLY the prompt text — no markdown headers, no JSON, no explanation
`.trim();

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
      max_tokens: 600,
      temperature: 0.1,
    });

    const raw = response.choices[0].message.content?.trim() ?? "[]";
    const parsed = JSON.parse(raw);
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
        return { canonicalName: group.canonicalName, specificity: "outlier", indices: group.indices, systemPrompt: null };
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

        const systemPrompt = promptResponse.choices[0].message.content?.trim() ?? null;
        return { canonicalName: group.canonicalName, specificity: group.specificity, indices: group.indices, systemPrompt };
      } catch (err) {
        console.error(`[listingContext] prompt generation failed for "${group.canonicalName}":`, err);
        return { canonicalName: group.canonicalName, specificity: group.specificity, indices: group.indices, systemPrompt: null };
      }
    }),
  );

  return withPrompts;
}
