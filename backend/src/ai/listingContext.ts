import OpenAI from "openai";
import fetch from "node-fetch";
import dotenv from "dotenv";
import { logUsage } from "../services/usageLogger";

dotenv.config({ quiet: true });

// ─── Groq client (8b-instant — prompt engineering only, separate TPM bucket) ──

const groq = new OpenAI({
  apiKey: process.env.GROQ_API_KEY!,
  baseURL: "https://api.groq.com/openai/v1",
});

// ─── Types ────────────────────────────────────────────────────────────────────

export interface ProductGroup {
  canonicalName: string;
  specificity: "specific" | "broad" | "outlier";
  indices: number[];
  systemPrompt: string | null;
  priceLow: number | null;
  priceHigh: number | null;
  estimatedShippingPrice: number | null;
}

interface RawGroup {
  canonicalName: string;
  indices: number[];
  serperQuery: string;
}

// ─── Serper ───────────────────────────────────────────────────────────────────

const SERPER_URL = "https://google.serper.dev/search";
const SERPER_TIMEOUT_MS = 6000;
const SERPER_COOLDOWN_MS = 3000;
const SERPER_MAX_RETRIES = 10;

function sleep(ms: number) { return new Promise<void>((r) => setTimeout(r, ms)); }

let serperRateLimitResetPromise: Promise<void> | null = null;

async function serperSearch(apiKey: string, query: string, num: number): Promise<any | null> {
  console.log(`[serper] → "${query}" (num=${num})`);
  for (let attempt = 0; attempt <= SERPER_MAX_RETRIES; attempt++) {
    if (serperRateLimitResetPromise) await serperRateLimitResetPromise;

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), SERPER_TIMEOUT_MS);

    try {
      const res = await fetch(SERPER_URL, {
        method: "POST",
        headers: { "X-API-KEY": apiKey, "Content-Type": "application/json" },
        body: JSON.stringify({ q: query, num }),
        signal: controller.signal as any,
      });

      if (res.status === 429) {
        if (!serperRateLimitResetPromise) {
          const retryAfterMs = parseInt(res.headers.get("retry-after") ?? "0", 10) * 1000;
          const waitMs = Math.max(retryAfterMs, SERPER_COOLDOWN_MS);
          console.warn(`[serper] 429 rate limit (attempt ${attempt + 1}/${SERPER_MAX_RETRIES}), cooling down ${waitMs}ms`);
          serperRateLimitResetPromise = sleep(waitMs).finally(() => { serperRateLimitResetPromise = null; });
        } else {
          console.warn(`[serper] 429 rate limit (attempt ${attempt + 1}/${SERPER_MAX_RETRIES}), joining existing cooldown`);
        }
        await serperRateLimitResetPromise;
        continue;
      }

      if (!res.ok) {
        console.error(`[listingContext] Serper HTTP ${res.status} for: ${query}`);
        return null;
      }

      const json = await res.json();
      console.log(`[serper] ✓ "${query}" — ${json?.organic?.length ?? 0} organic results`);
      return json;
    } catch (err: any) {
      if (err?.name === "AbortError") {
        console.warn(`[listingContext] Serper timed out: ${query}`);
        return null;
      }
      console.error("[listingContext] Serper fetch error:", err);
      return null;
    } finally {
      clearTimeout(timer);
    }
  }

  return null;
}

function extractOrganic(json: any, limit: number): string[] {
  return (json?.organic ?? [])
    .slice(0, limit)
    .map((r: any) => [r?.title ? `[${r.title}]` : "", r?.snippet ?? ""].filter(Boolean).join(" "))
    .filter(Boolean);
}

/**
 * Two parallel Serper searches for a specific product query:
 * one for resale pricing, one for condition/inspection/buying-guide signals.
 * Used by fetchMarketContext (legacy callers) and per-group context generation.
 */
export async function fetchMarketContext(query: string): Promise<string | null> {
  const apiKey = process.env.SERPER_API_KEY;
  if (!apiKey) {
    console.warn("[listingContext] SERPER_API_KEY not set — skipping market context");
    return null;
  }

  const [priceJson, inspectJson] = await Promise.all([
    serperSearch(apiKey, `${query} used resale price sold 2025 2026`, 8),
    serperSearch(apiKey, `${query} used buying guide inspect condition accessories what to look for`, 8),
  ]);

  const parts: string[] = [];

  if (priceJson) {
    const ab = priceJson?.answerBox;
    if (ab?.answer) parts.push(`Price summary: ${ab.answer}`);
    else if (ab?.snippet) parts.push(`Price summary: ${ab.snippet}`);
    if (priceJson?.knowledgeGraph?.description) parts.push(`Product overview: ${priceJson.knowledgeGraph.description}`);
    const rows = extractOrganic(priceJson, 8);
    if (rows.length) parts.push(`Pricing data:\n${rows.map((s, i) => `${i + 1}. ${s}`).join("\n")}`);
  }

  if (inspectJson) {
    const ab = inspectJson?.answerBox;
    if (ab?.answer || ab?.snippet) parts.push(`Buying guide summary: ${ab.answer ?? ab.snippet}`);
    const rows = extractOrganic(inspectJson, 8);
    if (rows.length) parts.push(`Condition & inspection data:\n${rows.map((s, i) => `${i + 1}. ${s}`).join("\n")}`);
  }

  return parts.length > 0 ? parts.join("\n\n") : null;
}

// ─── Step 1: Group listings by identical product (8b-instant) ─────────────────

const GROUPING_SYSTEM = `
You are a product classification specialist for a secondhand marketplace search tool.

Given a list of listing titles from a search query, group them by EXACT product — same brand, same model, same variant/spec. Each group gets a targeted Serper search query for used pricing.

GROUPING RULES:
- Only group listings you are CERTAIN are the exact same product — same brand, same model, same variant.
- When in doubt, give each listing its own group. Never merge speculatively.
- Different storage tiers are different products (128GB ≠ 256GB).
- Different specs are different products (9° driver ≠ 10.5° driver, RTX 4080 ≠ RTX 4090).
- Different generations are different products (iPhone 14 ≠ iPhone 15).
- A listing missing a key spec cannot be grouped with one that has it — treat it as its own group.
- Max 10 groups. If there are more distinct products than 10, consolidate the least specific ones.
- Canonical name must be as specific as the listing allows (e.g. "Ping G440 Max Driver 10.5°", "iPhone 14 Pro 256GB Space Black").
- PRODUCT TYPE IS PART OF PRODUCT IDENTITY: items that share a brand and model name but are different equipment types are NEVER the same product. Examples: a driver and an iron set are different products even if both say "Callaway Ai Smoke MAX"; a tennis racket and tennis strings are different; a GPU and a CPU are different.
- GOLF EQUIPMENT: always identify the club type from the title and include it in the canonicalName. Loft notation (e.g. 9°, 10.5°, "10.5 degree") unambiguously identifies a DRIVER — use "Driver" in the canonicalName. Iron-set notation (e.g. "7 Iron", "5-PW", "iron set") identifies IRONS. Club types to distinguish: Driver, Fairway Wood, Hybrid, Iron Set, Wedge, Putter. NEVER group a driver with an iron (or any other club type).

SERPER QUERY RULES:
- Each serperQuery must be highly targeted for used resale pricing of that exact product.
- Include brand, model, and key variant info (storage size, loft, generation, etc.).
- Do NOT use vague phrases — be as specific as the canonicalName.
- The serperQuery MUST include the product type word so it cannot match a different item in the same brand/model family. For golf clubs include "driver", "iron set", "wedge", etc. explicitly.
- Example: "Callaway Ai Smoke Max Driver 9 degree used price" not "Callaway Ai Smoke Max used price" (which could return iron results)

Return ONLY a JSON array (no markdown, no backticks, no extra text):
[
  {
    "canonicalName": "exact product name with key specs",
    "indices": [0, 3],
    "serperQuery": "targeted used resale price search query"
  }
]
`.trim();

async function groupListings(titles: string[], query: string): Promise<RawGroup[]> {
  if (titles.length === 0) return [];

  try {
    const titlesBlock = titles.map((t, i) => `${i}. ${t}`).join("\n");
    const response = await groq.chat.completions.create({
      model: "llama-3.1-8b-instant",
      messages: [
        { role: "system", content: GROUPING_SYSTEM },
        { role: "user", content: `Search query: "${query}"\n\nListing titles:\n${titlesBlock}` },
      ],
      max_tokens: 1200,
      temperature: 0.1,
    });
    logUsage("groq", "llama-3.1-8b-instant", response.usage);

    const raw = (response.choices[0].message.content ?? "").trim();
    const start = raw.indexOf("[");
    const end = raw.lastIndexOf("]");
    if (start === -1 || end === -1) throw new Error("No JSON array in grouping response");

    const parsed = JSON.parse(raw.slice(start, end + 1));
    if (!Array.isArray(parsed) || parsed.length === 0) throw new Error("Empty groups array");

    const groups = parsed
      .filter((g: any) => typeof g.canonicalName === "string" && Array.isArray(g.indices) && typeof g.serperQuery === "string")
      .map((g: any): RawGroup => ({
        canonicalName: g.canonicalName,
        indices: (g.indices as any[]).filter((i) => typeof i === "number"),
        serperQuery: g.serperQuery,
      }));

    console.log("[groupListings] groups:", groups.map(g => ({
      canonicalName: g.canonicalName,
      indices: g.indices,
      serperQuery: g.serperQuery,
    })));

    return groups;
  } catch (err) {
    console.error("[listingContext] Grouping failed, falling back to single group:", err);
    return [{ canonicalName: query, indices: titles.map((_, i) => i), serperQuery: `${query} used resale price` }];
  }
}

// ─── Step 2+3: Serper + 8b prompt engineering per group ──────────────────────

const PROMPT_ENGINEER_SYSTEM = `
You are a product research specialist. Your job is to read raw Google search results about a secondhand product and write a detailed, expert system prompt that turns an AI scoring model into a genuine domain expert on that exact product.

The AI you are writing for receives secondhand marketplace listings (title, price, condition, images, description) and scores them across five categories: priceFairness, conditionHonesty, descriptionQuality, sellerTrust, and shippingFairness.

OUTPUT FORMAT — use exactly this structure, nothing else:

PRICE_LOW: <integer USD, e.g. 450, or null>
PRICE_HIGH: <integer USD, e.g. 700, or null>
---
<the full expert system prompt starts here>

THE SYSTEM PROMPT (everything after ---) MUST CONTAIN ALL OF THESE IN ORDER:

1. IDENTITY LINE
   Open with: "You are an expert evaluating secondhand marketplace listings for: [full product name and key specs]."
   Commit to the most specific product identity the data supports. Do not hedge.
   CRITICAL: Your identity line MUST match the canonicalName exactly. If the canonicalName says "Driver", you are evaluating a driver — never say "iron", "iron set", or any other club type. The canonical product name is authoritative; if the search data appears to describe a different product, discard that data and rely on your own knowledge of the canonical product instead.

2. MARKET VALUE
   State the used market price range: "Used [product] typically sells for $X–$Y."
   Favour the most cited or most reputable sources (eBay sold, Swappa, StockX, etc.).
   If data is thin, use your own knowledge — never say "data unavailable".

3. PHYSICAL INSPECTION POINTS (numbered list, 4–6 items)
   Specific things a buyer must check for THIS exact product:
   - Pokémon cards: corner whitening, edge whitening, holo scratches, print lines, bends, ink marks
   - Golf drivers: crown scratches, face paint wear, shaft condition, ferrule, headcover present
   - iPhones: screen burn-in, back glass cracks, Face ID function, battery health %, True Tone
   - Sneakers: sole separation, midsole yellowing, toe box crease, lace condition, insole
   - Electronics: screen condition, port wear, battery cycle count, physical dents/cracks
   Use this level of specificity for whatever product this is.

4. ACCESSORIES & COMPLETENESS (numbered list, 2–4 items)
   What should be included and the value impact if missing:
   - Golf club: headcover (−$20–40 if missing), shaft band/sticker
   - Trading card: original sleeve if claimed NM/M, graded slab if claimed graded
   - Electronics: original charger, box, cables, documentation

5. RED FLAGS & SCAM SIGNALS (numbered list, 4–6 items)
   Warning signs specific to this product:
   - Photo tricks used to hide damage (angled shots on driver crowns, low-res card photos)
   - Common seller misrepresentations for this exact item
   - Price-too-good-to-be-true thresholds for this product
   - Known fakes/counterfeits if applicable (Pokémon cards, branded sneakers, electronics)
   - Vague condition language sellers use to avoid accountability ("light use", "good condition")

6. SCORING GUIDANCE (inline, no sub-headers)
   PRICE FAIRNESS: [anchor to the market range — at or below the low end = minimum 80, scale up further below market; at or above high end = penalise based on condition and extras]
   CONDITION HONESTY: [reference the inspection points above; CRITICAL HARD CAP: if ANY wear, scratch, scuff, dent, or damage from the inspection list is visible in the images OR acknowledged in the description, AND the condition is claimed "new", "like new", or equivalent, the conditionHonesty score MUST be 50 or below — no exceptions, no qualifiers; wear across multiple areas = 35 or below; do NOT write off defects as "minor" or "no major damage" — any defect under a new/like-new claim IS a mismatch; penalise blurry or angled shots that hide known wear areas for this product]
   DESCRIPTION QUALITY: [what a complete honest listing for this exact product includes — model, variant, condition details, accessory list, disclosed defects]
   SELLER TRUST: [how to apply the red flags above; what raises vs lowers trust for this product]
   SHIPPING FAIRNESS: [judge shipping cost given this product's size, weight, and fragility]

RULES:
- Every section must be specific to this exact product — never say "similar items", "this category", or "this type of product"
- Write in second person to the scoring AI: "You are an expert...", "Watch for...", "Check whether..."
- Be direct and confident. Do not hedge excessively.
- Draw on your own product knowledge where search data is thin
- Everything after --- is plain prose and lists — no JSON, no markdown headers, no code blocks
- PRICE_LOW and PRICE_HIGH are plain integers, e.g. 450, or the word null
`.trim();

function parsePriceValue(raw: string): number | null {
  // Find the first integer anywhere in the string so "around $1,200" / "~45" / "approx 80" all parse
  const match = raw.replace(/[$,]/g, "").match(/\d+/);
  const v = match ? parseInt(match[0], 10) : NaN;
  return isNaN(v) ? null : v;
}

function parseEngineeredOutput(raw: string): { systemPrompt: string | null; priceLow: number | null; priceHigh: number | null } {
  const lines = raw.split("\n");
  let priceLow: number | null = null;
  let priceHigh: number | null = null;
  let dividerIdx = -1;

  for (let i = 0; i < lines.length; i++) {
    // Strip markdown bold markers (**PRICE_LOW:** or __PRICE_LOW:__) that LLMs sometimes add
    const line = lines[i].trim().replace(/^\*{1,2}|^\_{1,2}|\*{1,2}$|\_{1,2}$/g, "").trim();
    const upper = line.toUpperCase();
    if (upper.startsWith("PRICE_LOW:")) {
      priceLow = parsePriceValue(line.slice(line.indexOf(":") + 1).trim());
    } else if (upper.startsWith("PRICE_HIGH:")) {
      priceHigh = parsePriceValue(line.slice(line.indexOf(":") + 1).trim());
    } else if (line === "---") {
      dividerIdx = i;
      break;
    }
  }

  const systemPrompt = dividerIdx >= 0
    ? lines.slice(dividerIdx + 1).join("\n").trim() || null
    : null;

  if (!systemPrompt) {
    console.error("[listingContext] No system prompt found after ---. Raw output snippet:\n", raw.slice(0, 400));
  }

  if (systemPrompt && (priceLow === null || priceHigh === null)) {
    console.warn("[listingContext] System prompt parsed but price values missing — raw header lines:\n",
      lines.slice(0, Math.min(dividerIdx >= 0 ? dividerIdx : 5, 5)).join("\n"));
  }

  return { systemPrompt, priceLow, priceHigh };
}

async function engineerPrompt(
  canonicalName: string,
  marketData: string,
): Promise<{ systemPrompt: string | null; priceLow: number | null; priceHigh: number | null }> {
  try {
    console.log(`[engineerPrompt] → "${canonicalName}" (market data: ${marketData.length} chars)`);
    const response = await groq.chat.completions.create({
      model: "llama-3.1-8b-instant",
      messages: [
        { role: "system", content: PROMPT_ENGINEER_SYSTEM },
        { role: "user", content: `Product: "${canonicalName}"\n\n${marketData}` },
      ],
      max_tokens: 2000,
      temperature: 0.15,
    });
    logUsage("groq", "llama-3.1-8b-instant", response.usage);

    const result = parseEngineeredOutput((response.choices[0].message.content ?? "").trim());
    console.log(`[engineerPrompt] ✓ "${canonicalName}" — priceLow=${result.priceLow} priceHigh=${result.priceHigh} systemPrompt=${result.systemPrompt ? result.systemPrompt.length + " chars" : "null"}`);
    return result;
  } catch (err) {
    console.error(`[listingContext] Prompt engineering failed for "${canonicalName}":`, err);
    return { systemPrompt: null, priceLow: null, priceHigh: null };
  }
}

// ─── Shipping weight estimation ──────────────────────────────────────────────


function parseWeightLbs(text: string): number | null {
  // Ordered by specificity — prefer "shipping weight" matches first
  const patterns: [RegExp, (v: number) => number][] = [
    [/shipping\s+weight[:\s]+(\d+(?:\.\d+)?)\s*(?:lbs?|pounds?)/i, v => v],
    [/(?:package|item|product)\s+weight[:\s]+(\d+(?:\.\d+)?)\s*(?:lbs?|pounds?)/i, v => v],
    [/(\d+(?:\.\d+)?)\s*(?:lbs?|pounds?)/i, v => v],
    [/shipping\s+weight[:\s]+(\d+(?:\.\d+)?)\s*(?:oz|ounces?)/i, v => v / 16],
    [/(\d+(?:\.\d+)?)\s*(?:oz|ounces?)/i, v => v / 16],
    [/(\d+(?:\.\d+)?)\s*(?:kg|kilograms?)/i, v => v * 2.205],
    [/(\d+(?:\.\d+)?)\s*g\b/i, v => v / 453.6],
  ];

  for (const [pattern, convert] of patterns) {
    const match = text.match(pattern);
    if (match) {
      const val = parseFloat(match[1]);
      if (Number.isFinite(val) && val > 0) return convert(val);
    }
  }
  return null;
}

// US domestic average (UPS Ground zones 4–6 blend). Rounded to nearest $10.
function estimateShippingFromWeight(lbs: number): number {
  let raw: number;
  if (lbs <= 0.5) raw = 8;
  else if (lbs <= 1)  raw = 9;
  else if (lbs <= 2)  raw = 11;
  else if (lbs <= 3)  raw = 13;
  else if (lbs <= 5)  raw = 16;
  else if (lbs <= 10) raw = 22;
  else if (lbs <= 20) raw = 32;
  else raw = 45;
  return Math.round(raw / 10) * 10;
}

// ─── Main export ──────────────────────────────────────────────────────────────

export async function groupAndContextualize(
  titles: string[],
  query: string,
  hasCalculatedShipping?: boolean[],
): Promise<ProductGroup[]> {
  if (titles.length === 0) return [];

  const serperApiKey = process.env.SERPER_API_KEY;

  // Step 1: group by identical product (8b-instant, one call)
  const rawGroups = await groupListings(titles, query);

  // Steps 2+3: per group — Serper ×2 (+ optional weight search) then 8b engineers the expert prompt
  // Run in chunks of 2 to avoid Serper rate limits (each group fires 2–3 concurrent requests)
  const SERPER_CONCURRENCY = 2;
  const groups: ProductGroup[] = [];

  for (let i = 0; i < rawGroups.length; i += SERPER_CONCURRENCY) {
    const chunk = rawGroups.slice(i, i + SERPER_CONCURRENCY);
    const chunkResults = await Promise.all(
      chunk.map(async (group): Promise<ProductGroup> => {
        const needsWeightLookup =
          serperApiKey &&
          hasCalculatedShipping &&
          group.indices.some(idx => hasCalculatedShipping[idx]);

        const [priceJson, inspectJson, weightJson] = await Promise.all([
          serperApiKey
            ? serperSearch(serperApiKey, `${group.serperQuery} used resale price sold 2025 2026`, 8).catch(() => null)
            : Promise.resolve(null),
          serperApiKey
            ? serperSearch(serperApiKey, `${group.canonicalName} used buying guide inspect condition accessories what to look for`, 8).catch(() => null)
            : Promise.resolve(null),
          needsWeightLookup
            ? serperSearch(serperApiKey!, `${group.canonicalName} shipping weight`, 5).catch(() => null)
            : Promise.resolve(null),
        ]);

        // Build unified market data string
        const parts: string[] = [];

        if (priceJson) {
          const ab = priceJson?.answerBox;
          if (ab?.answer) parts.push(`Price summary: ${ab.answer}`);
          else if (ab?.snippet) parts.push(`Price summary: ${ab.snippet}`);
          if (priceJson?.knowledgeGraph?.description) parts.push(`Product overview: ${priceJson.knowledgeGraph.description}`);
          const rows = extractOrganic(priceJson, 8);
          if (rows.length) parts.push(`Pricing data:\n${rows.map((s: string, i: number) => `${i + 1}. ${s}`).join("\n")}`);
        }

        if (inspectJson) {
          const ab = inspectJson?.answerBox;
          if (ab?.answer || ab?.snippet) parts.push(`Buying guide summary: ${ab.answer ?? ab.snippet}`);
          const rows = extractOrganic(inspectJson, 8);
          if (rows.length) parts.push(`Condition & inspection data:\n${rows.map((s: string, i: number) => `${i + 1}. ${s}`).join("\n")}`);
        }

        const marketData = parts.length > 0 ? parts.join("\n\n") : null;

        // Resolve estimated shipping price from weight search
        let estimatedShippingPrice: number | null = null;
        if (weightJson) {
          const answerText = [weightJson?.answerBox?.answer, weightJson?.answerBox?.snippet]
            .filter(Boolean).join(" ");
          const snippetText = extractOrganic(weightJson, 5).join(" ");
          const weightLbs = parseWeightLbs(`${answerText} ${snippetText}`);
          if (weightLbs !== null) {
            const shippingLbs = Math.max(weightLbs, 0.5) + (weightLbs < 0.5 ? 0.5 : 0);
            estimatedShippingPrice = estimateShippingFromWeight(shippingLbs);
          }
        }

        if (!marketData) {
          return {
            canonicalName: group.canonicalName,
            specificity: "specific",
            indices: group.indices,
            systemPrompt: null,
            priceLow: null,
            priceHigh: null,
            estimatedShippingPrice,
          };
        }

        const { systemPrompt, priceLow, priceHigh } = await engineerPrompt(group.canonicalName, marketData);
        console.log(`[group] "${group.canonicalName}" — final priceLow=${priceLow} priceHigh=${priceHigh}`);

        return {
          canonicalName: group.canonicalName,
          specificity: "specific",
          indices: group.indices,
          systemPrompt,
          priceLow,
          priceHigh,
          estimatedShippingPrice,
        };
      }),
    );
    groups.push(...chunkResults);
  }

  return groups;
}
