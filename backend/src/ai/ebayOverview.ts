import OpenAI from "openai";
import dotenv from "dotenv";
import { calculatePriceFairness } from "../services/scoring/priceFairnessScore";
import { extractBatchObjects } from "../utils/extractBatchObjects";
import { validateAnalysis, EMPTY_ANALYSIS } from "../utils/extractStructuredAnalysis";
import { stitchBuffers, gridLayoutNote, planImageBlocks, MAX_CELLS, type StitchResult } from "./stitchImages";

export interface VisionBatchOpts {
  /** When true, each listing's photos are stitched into a single grid image (1 image/listing). */
  stitch?: boolean;
}

const EBAY_SCORE_KEYS = new Set([
  "priceFairness",
  "conditionHonesty",
  "shippingFairness",
  "descriptionQuality",
]);

dotenv.config({ quiet: true });

const groq = new OpenAI({
  apiKey: process.env.GROQ_API_KEY!,
  baseURL: "https://api.groq.com/openai/v1",
});

function sleep(ms: number) { return new Promise<void>((r) => setTimeout(r, ms)); }

const RATE_LIMIT_COOLDOWN_MS = 3000;
const MAX_RETRIES = 10;

// Shared cooldown: all concurrent callers join the same wait instead of each spinning independently
let rateLimitResetPromise: Promise<void> | null = null;

async function groqWithRetry<T>(fn: () => Promise<T>): Promise<T> {
  let lastErr: any;
  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    // If another call is already cooling down, join that wait before trying
    if (rateLimitResetPromise) await rateLimitResetPromise;

    try {
      return await fn();
    } catch (err: any) {
      lastErr = err;
      if (err?.status === 429) {
        if (!rateLimitResetPromise) {
          // First failure — own the cooldown
          const retryAfterMs = parseInt(err?.headers?.get?.("retry-after") ?? "0", 10) * 1000;
          const waitMs = Math.max(retryAfterMs, RATE_LIMIT_COOLDOWN_MS);
          console.warn(`[groq] 429 rate limit (attempt ${attempt + 1}/${MAX_RETRIES}), cooling down ${waitMs}ms`);
          rateLimitResetPromise = sleep(waitMs).finally(() => { rateLimitResetPromise = null; });
        } else {
          console.warn(`[groq] 429 rate limit (attempt ${attempt + 1}/${MAX_RETRIES}), joining existing cooldown`);
        }
        await rateLimitResetPromise;
        continue;
      }
      throw err;
    }
  }
  throw lastErr;
}


function clean(v: any): string | undefined {
  if (v === undefined || v === null) return undefined;
  const s = String(v).trim();
  if (!s) return undefined;
  const lower = s.toLowerCase();
  if (lower === "undefined" || lower === "null" || lower === "n/a") return undefined;
  if (/^undefined(\s*,\s*undefined)*$/i.test(s)) return undefined;
  return s;
}

function formatLocation(listing: any): string {
  const loc = listing.itemLocation ?? listing.location;

  // if it's already a string, use it
  if (typeof loc === "string") return clean(loc) ?? "N/A";

  // if it's an object (eBay itemLocation shape), build a readable string
  if (loc && typeof loc === "object") {
    const parts = [loc.city, loc.stateOrProvince, loc.postalCode, loc.country]
      .map(clean)
      .filter(Boolean) as string[];
    return parts.length ? parts.join(", ") : "N/A";
  }

  return "N/A";
}

function formatBuyingOptions(v: any): string {
  if (Array.isArray(v)) return v.map(String).map((x) => x.trim()).filter(Boolean).join(", ") || "N/A";
  if (typeof v === "string") return clean(v) ?? "N/A";
  return "N/A";
}

function formatShippingLine(listing: any): string {
  if (listing.shippingPrice === 0) return "Free";
  if (listing.shippingEstimated && listing.shippingPrice != null) {
    return `$${listing.shippingPrice} (estimated from weight lookup — shippingEstimated: true)`;
  }
  if (listing.shippingPrice != null) return `$${listing.shippingPrice}`;
  return formatShippingOptions(listing.shippingOptions);
}

function formatShippingOptions(v: any): string {
  if (v === undefined || v === null) return "N/A";

  // if it's a JSON string, parse once so it doesn't look double-encoded
  if (typeof v === "string") {
    const s = clean(v);
    if (!s) return "N/A";
    try {
      const parsed = JSON.parse(s);
      return JSON.stringify(parsed);
    } catch {
      return s;
    }
  }

  // object/array
  try {
    return JSON.stringify(v);
  } catch {
    return "N/A";
  }
}

function formatFeedback(listing: any): string {
  const fb = clean(listing.feedback);
  const score = listing.score;

  if (fb) {
    const hasPercent = fb.includes("%");
    const hasRatingsInText = fb.includes("(") || fb.toLowerCase().includes("rating");
    if (hasRatingsInText) return fb; // already has rating count etc.
    return `${fb}${hasPercent ? "" : "%"}${score != null ? ` (${score} ratings)` : ""}`;
  }

  return score != null ? `${score} ratings` : "N/A";
}

function formatOriginalPrice(marketingPrice: any): string {
  const op = marketingPrice?.originalPrice;
  if (!op) return "N/A";
  // eBay often uses { value, currency }
  const value = op?.value ?? op;
  const currency = op?.currency ?? marketingPrice?.originalPriceCurrency;
  const v = clean(value);
  if (!v) return "N/A";
  return currency ? `${v} ${currency}` : v;
}

function formatDiscount(marketingPrice: any): string {
  const d = marketingPrice?.discountPercentage ?? marketingPrice?.discountPercent;
  if (typeof d === "number" && Number.isFinite(d)) return `${d}%`;
  const s = clean(d);
  return s ? (s.includes("%") ? s : `${s}%`) : "N/A";
}

function stripHtml(html: string): string {
  return html.replace(/<[^>]*>/g, " ").replace(/\s{2,}/g, " ").trim();
}

function isVariationListing(listing: any): boolean {
  if (listing.itemGroupId) return true;
  const id = String(listing.id ?? listing.itemId ?? "");
  return /^v1\|\d+\|[1-9]\d*$/.test(id);
}

/**
 * Build the exact system+user message array used to analyze a single eBay listing.
 * Extracted so both the synchronous path (analyzeListingWithImages) and the
 * Groq Batch API path (ebayBatchApi.ts) score listings with an identical prompt.
 */
// Pack a listing's photos into ≤5 image blocks: raw single-photo blocks while
// they fit, stitched grids for the overflow so no photo is dropped. eBay images
// are public URLs, so single blocks stay as URLs (no fetch); only grouped photos
// are fetched + stitched.
async function buildEbayImageBlocks(urls: string[]): Promise<{ blocks: any[]; stitchedAny: boolean }> {
  const groups = planImageBlocks(urls.length, 5, MAX_CELLS);
  const blocks: any[] = [];
  let stitchedAny = false;

  for (const g of groups) {
    if (g.length === 1) {
      blocks.push({ type: "image_url", image_url: { url: urls[g[0]] } });
      continue;
    }
    const buffers = (await Promise.all(g.map((i) => fetchImageBuffer(urls[i])))).filter((b): b is Buffer => b !== null);
    const stitched = buffers.length ? await stitchBuffers(buffers) : null;
    if (stitched) {
      blocks.push({ type: "image_url", image_url: { url: stitched.dataUrl } });
      stitchedAny = true;
    } else {
      // Fetch/stitch failed — fall back to one representative raw URL for the group.
      blocks.push({ type: "image_url", image_url: { url: urls[g[0]] } });
    }
  }

  return { blocks, stitchedAny };
}

/**
 * Build the exact vision images (raw photo URLs + stitched grids) the scoring
 * model receives for an eBay listing — for on-demand debug inspection. Mirrors
 * the image pipeline in buildEbayAnalysisMessages.
 */
export async function getEbayVisionImages(listing: any): Promise<string[]> {
  const imageUrls: string[] = Array.isArray(listing.imageUrls)
    ? listing.imageUrls.filter((u: any) => typeof u === "string" && u.trim())
    : Array.isArray(listing.images)
      ? listing.images.filter((u: any) => typeof u === "string" && u.trim())
      : [];
  const { blocks } = await buildEbayImageBlocks(imageUrls);
  return blocks
    .map((b: any) => b?.image_url?.url)
    .filter((u: any): u is string => typeof u === "string");
}

export async function buildEbayAnalysisMessages(listing: any, context?: string | null): Promise<any[]> {
  const isVariation = isVariationListing(listing);
  const title = clean(listing.title) ?? "Untitled";
  const currency = clean(listing.currency) ?? "USD";
  const link = clean(listing.link ?? listing.url) ?? "";

  const seller = clean(listing.seller) ?? "N/A";
  const feedbackLine = formatFeedback(listing);

  const condition = clean(listing.condition) ?? "N/A";
  const conditionDescriptor = clean(listing.conditionDescriptor) ?? "N/A";

  const itemLocation = formatLocation(listing);
  const buyingOptions = formatBuyingOptions(listing.buyingOptions);
  const shippingLine = formatShippingLine(listing);

  const shortDesc = clean(listing.shortDescription) ?? "";
  const rawDesc = listing.description || listing.fullDescription || "";
  const description = clean(stripHtml(rawDesc)) ?? "";

  const imageUrls: string[] = Array.isArray(listing.imageUrls)
    ? listing.imageUrls.filter((u: any) => typeof u === "string" && u.trim())
    : Array.isArray(listing.images)
      ? listing.images.filter((u: any) => typeof u === "string" && u.trim())
      : [];

  const messages: any[] = [
    {
      role: "system",
      content: `
You are an expert AI specializing in evaluating online marketplace listings.

🎯 Your job:
Analyze the listing and produce *numeric scores* for the following categories ONLY:

- priceFairness (0–100) *compare to recent similar listings*
- conditionHonesty (0–100) *carefully weigh the description against the images and highlight any and all discrepancies; does the description match the images, and do they both match the stated condition*
- shippingFairness (0–100) *is the shipping price reasonable for the item and location*
- descriptionQuality (0–100) *is the description detailed, accurate, and well-written*

If shipping is free, automatically give full points (100) for shippingFairness.
If a shipping cost is present, score it on reasonableness for the item's size, weight, and price — a small flat fee on a high-value item is excellent (90–100), not a penalty. Do NOT score paid shipping low simply because it is not free.
If a shipping cost is present but marked as estimated (shippingEstimated: true), score it normally — judge whether the estimate is reasonable for the item's size and weight.
If shipping cost is truly unknown (no price and no estimate), treat shippingFairness as neutral (score 65) — never penalize for unresolved calculated shipping.
A Suggested Price Fairness score is pre-calculated from market data and included in the listing fields. Use it as-is unless there is a clear qualitative reason to adjust (e.g. parts/repair only, seller discloses damage beyond the stated condition, obvious fraud signals). Do not adjust based on price position alone. When the suggested score is N/A, estimate from the PRODUCT CONTEXT price range or your own knowledge.

If any field is missing/undefined, treat it as NEUTRAL (no deduction, no reward). Missing data should NEVER lower a score unless it's critical (e.g., description or seller ratings).
ALWAYS INCLUDE A DESCRIPTION OF THE IMAGES IN THE OVERVIEW SECTION (unless none were provided).
ALWAYS carefully weigh the description against the images and highlight any and all discrepancies between them.

CONDITION HONESTY RULES:
- Scrutinize images closely for scratches, dents, scuffs, discoloration, missing parts, or any visible damage to the ITEM ITSELF
- When condition is "New", "Like New", or "Open Box" AND wear to the actual item is present:
  - The conditionHonesty score MUST be 50 or below — no exceptions
  - Wear on multiple areas = 35 or below
  - Do NOT use phrases like "no major damage", "minor wear", "some wear", "light scratches", or any other qualifier that softens the finding — these phrases are red flags that you are about to score too high
  - SELF-CHECK: if your overview mentions wear/scratch/scuff/dent/damage/mark/discoloration ON THE ITEM ITSELF AND condition is "New" or "Like New", your conditionHonesty score MUST be 50 or below
- EXCEPTION — PACKAGING DAMAGE: box or packaging damage on an otherwise sealed/new item is NOT item wear. When a seller proactively discloses minor box or packaging damage on a new item, treat this as honest disclosure — do NOT penalize conditionHonesty for it. The condition refers to the product, not the box.
- EXCEPTION — STOCK/MANUFACTURER IMAGES: for brand-new factory-sealed items, using official product or manufacturer images is completely normal and expected. Do NOT treat this as a discrepancy or flag it as suspicious. Only penalize if images show the actual item with visible damage that contradicts the stated condition.
- EXCEPTION — GRADED ITEMS: if the item is professionally graded (PSA, BGS, CGC, SGC, etc.), the grade IS the certified condition; do NOT apply the like-new wear rules — instead evaluate whether the grade label is visible, legible, and consistent with the images
- Do NOT penalize honest sellers who proactively note minor cosmetic issues — note it in the overview but do not let it drive the score down as if it were undisclosed damage
- Use PRODUCT CONTEXT condition signals and red flags as a checklist for what to look for in images
- Call out all defects to the item explicitly in the overview — do not soften, excuse, or offset them with positives
- Multiple images showing different angles of the same item (front, back, sides, slab label) are completely normal — do NOT flag this as suspicious or as evidence of a different item

OVERVIEW TONE RULES:
- Do NOT use the words "scam", "suspicious", "fraud", or "attempt to scam" based on any single signal alone (low price, calculated shipping, sparse description)
- Calculated shipping is NEVER a scam signal — do not mention it negatively in the overview
- A low price relative to market is worth noting but must be framed as a pricing observation, not an accusation
- Only raise fraud concerns when multiple explicit red flags combine (e.g. price far below market AND mismatched images AND no seller history)

🎯 Output Format **MUST ALWAYS BE EXACTLY LIKE THIS**:

{
  "scores": {
    "priceFairness": <number>,
    "conditionHonesty": <number>,
    "shippingFairness": <number>,
    "descriptionQuality": <number>
  },
  "overview": "Short reasoning paragraph here.",
  "highlights": [{ "label": "Headcover included", "positive": true }, { "label": "Grip worn", "positive": false }]
}

HIGHLIGHTS RULES:
- First scan the PRODUCT CONTEXT block for accessories and inspection points specific to this item (e.g. original box, charger, case, manual, tools, cables, accessories). If those items are present or confirmed in the listing, mark positive. If they are expected but absent, mark negative.
- Then add clearly observable positive or negative details from the title, description, or images — such as shipping, seller reputation, or notable item specifics.
- Do NOT surface the condition label (e.g. "Used condition", "Like New") as a highlight. Only flag condition if the images visibly contradict the stated condition (e.g. visible damage on a "Like New" claim).
- For shipping: mark positive if free ("Free shipping"). Mark negative ONLY if the cost is unreasonably high relative to the item price (e.g. $25 shipping on a $30 item). Do NOT flag shipping negatively just because it has a cost — a small flat fee on a high-value item is normal and should not appear as a highlight at all.
- Output 3–6 highlights total. Each label must be ≤10 words and state a specific fact.
- Order by importance — most buyer-relevant facts first. The first two will be featured on search cards.
- Good label examples: "Original box included", "Charger included", "Free shipping", "Top-rated seller", "Missing accessories", "Visible wear in images"
- Only include highlights with clear evidence. Do NOT pad or invent.

‼️ Return ONLY the JSON object above. No markdown fences. No backticks. No commentary. No DEBUG INFO. No extra fields beyond scores, overview, and highlights.
‼️ DO NOT include any scoring numbers inside the overview text.
`,
    },
    {
      role: "user",
      content: [
        { type: "text", text: `Title: ${title}` },
        { type: "text", text: isVariation ? `Price: VARIES — this is a variation listing; price depends on the selected option` : `Price: ${listing.price} ${currency}` },

        { type: "text", text: `Seller: ${seller}` },
        { type: "text", text: `Feedback: ${feedbackLine}` },

        { type: "text", text: `Condition: ${condition}` },
        { type: "text", text: `Condition Descriptor: ${conditionDescriptor}` },

        { type: "text", text: `Item Location: ${itemLocation}` },
        { type: "text", text: `Buying Options: ${buyingOptions}` },
        { type: "text", text: `Shipping: ${shippingLine}` },

        { type: "text", text: `Original Price: ${formatOriginalPrice(listing.marketingPrice)}` },
        { type: "text", text: `Discount: ${formatDiscount(listing.marketingPrice)}` },

        { type: "text", text: `Short Description: ${shortDesc}` },
        { type: "text", text: `Description: ${description}` },

        { type: "text", text: `Listing URL: ${link}` },
        { type: "text", text: `Images Provided: ${imageUrls.length}` },
        { type: "text", text: `Suggested Price Fairness: ${isVariation ? "N/A — variation listing" : (calculatePriceFairness(listing.price, context, listing.priceLow, listing.priceHigh) ?? "N/A")}` },
        ...(isVariation ? [{ type: "text", text: `IMPORTANT: This is a variation listing. Price varies across options and cannot be fairly assessed. Do NOT include priceFairness in your scores object — omit the key entirely. Score only: conditionHonesty, shippingFairness, descriptionQuality.` }] : []),
        ...(context ? [{ type: "text", text: `\n--- PRODUCT CONTEXT ---\n${context}\n--- END PRODUCT CONTEXT ---` }] : []),
      ],
    },
  ];

  const { blocks, stitchedAny } = await buildEbayImageBlocks(imageUrls);
  if (stitchedAny) {
    messages[1].content.push({
      type: "text",
      text: "NOTE ON IMAGES: some images below are grids combining multiple separate photos of this SAME item (read left-to-right, top-to-bottom; white padding is letterboxing). Treat every photo/cell as the same listing — multiple angles are normal, not suspicious.",
    });
  }
  for (const block of blocks) messages[1].content.push(block);

  return messages;
}

export async function analyzeListingWithImages(listing: any, context?: string | null) {
  const messages = await buildEbayAnalysisMessages(listing, context);

  const response = await groq.chat.completions.create({
    model: "meta-llama/llama-4-scout-17b-16e-instruct",
    messages,
    max_tokens: 1000,
    temperature: 0.2,
    response_format: { type: "json_object" },
  });

  return response.choices[0].message.content?.trim() || "{}";
}

// ---------------------------------------------------------------------------
// Batch analysis — analyzes multiple listings in a single API call
// ---------------------------------------------------------------------------


// Appended to any generated system prompt so the output shape stays consistent
const EBAY_BATCH_OUTPUT_FORMAT = `
You will receive multiple eBay listings numbered 1 through N (each wrapped in === LISTING N === / === END LISTING N ===).
Analyze ALL of them and return results as a JSON object containing a "listings" array.

ALWAYS APPLY:
- priceFairness: a Suggested Price Fairness score is pre-calculated from market data and included with each listing. Use it as-is unless there is a clear qualitative reason to adjust (e.g. listing is for parts/repair only, seller discloses damage beyond the stated condition, obvious fraud signals). Do not adjust based on price position alone — that is already accounted for. When the suggested score is N/A, estimate from the PRODUCT CONTEXT price range or your own knowledge.
- shippingFairness auto 100 if free; if a cost is present, score on reasonableness for the item's size and price (small flat fee on a high-value item = 90–100, NOT a penalty); if shippingEstimated is true, score normally against the estimate; score 65 (neutral) only if cost is truly unknown — never score paid shipping low just because it is not free
- Missing data = NEUTRAL (no deduction unless truly critical)
- Describe images in the overview if provided
- Carefully weigh the description against the images and highlight any and all discrepancies
- Scrutinize images for scratches, dents, scuffs, or damage to the ITEM ITSELF — when condition is "New", "Like New", or "Open Box" AND actual item wear is present: conditionHonesty MUST be 50 or below; multiple areas of wear = 35 or below; do NOT use "minor wear", "some wear", "no major damage"; SELF-CHECK: if overview mentions wear/scratch/damage ON THE ITEM and condition is new/like-new, cap at 50
- EXCEPTION: box or packaging damage disclosed by the seller does NOT lower conditionHonesty — condition refers to the product, not the box; proactive seller disclosure is honest
- EXCEPTION: official/manufacturer images for new factory-sealed items are normal — do not treat as a discrepancy
- EXCEPTION: graded items (PSA, BGS, CGC, etc.) are exempt from the above wear rule — the grade IS the certified condition
- Multiple images showing different angles of the same item (front, back, sides) are completely normal — do NOT treat this as suspicious
- Do NOT use "scam", "suspicious", or "fraud" language based on any single signal — only raise concerns when multiple explicit red flags combine
- DO NOT include numeric scores inside the overview text
- DO NOT add extra fields beyond listingIndex, scores, overview, and highlights

JSON FORMATTING RULES — your output must be valid JSON that passes JSON.parse() without modification:
- Return a single JSON object with one key: "listings"
- Write every "overview" value as a single unbroken line — no literal newline characters inside any string value
- No markdown fences, no backticks, no commentary, no preamble

HIGHLIGHTS RULES (apply to every listing):
- First scan the PRODUCT CONTEXT block for accessories and inspection points for this item type. Surface presence as positive, absence as negative.
- Then add clearly observable positive or negative details from title, description, or images — such as shipping, seller reputation, or notable item specifics.
- Do NOT surface the condition label as a highlight. Only flag condition if images visibly contradict the stated condition (e.g. visible damage on a "Like New" claim).
- For shipping: positive if free ("Free shipping"). Negative ONLY if the cost is unreasonably high relative to item price (e.g. $25 shipping on a $30 item). Do NOT generate a shipping highlight at all if the cost is reasonable — having a small flat fee is normal, not a flaw.
- Output 3–6 highlights per listing. Labels ≤10 words, factual.
- Order by importance — most buyer-relevant facts first. The first two will be featured on search cards.
- Examples: "Original box included", "Charger included", "Free shipping", "Top-rated seller", "Missing accessories", "Visible wear in images"
- Only include highlights with clear evidence. Do NOT pad.

OUTPUT FORMAT — return ONLY this JSON object:
{
  "listings": [
    {
      "listingIndex": 0,
      "scores": { "priceFairness": <n>, "conditionHonesty": <n>, "shippingFairness": <n>, "descriptionQuality": <n> },
      "overview": "Short reasoning paragraph.",
      "highlights": [{ "label": "...", "positive": true }]
    }
  ]
}
`.trim();

export const EBAY_BATCH_SYSTEM_PROMPT = `
You are an expert AI specializing in evaluating eBay listings for a deal-finding product.

You will receive multiple listings numbered 1 through N (each wrapped in === LISTING N === / === END LISTING N ===).
Analyze ALL of them and return results as a JSON object containing a "listings" array.

SCORING RULES (apply to every listing):
- priceFairness (0–100): a Suggested Price Fairness score is pre-calculated from market data and included with each listing. Use it as-is unless there is a clear qualitative reason to adjust (e.g. parts/repair only, seller discloses damage beyond the stated condition, obvious fraud signals). Do not adjust based on price position alone. When the suggested score is N/A, estimate from the PRODUCT CONTEXT price range or your own knowledge.
- conditionHonesty (0–100): scrutinize images for scratches, dents, scuffs, discoloration, missing parts, or damage to the ITEM ITSELF; when condition is "New", "Like New", or "Open Box" AND actual item wear is present: score MUST be 50 or below; multiple areas of wear = 35 or below; do NOT use "minor wear" / "no major damage"; SELF-CHECK: if overview mentions wear/scratch/damage ON THE ITEM and condition is new/like-new, cap at 50; EXCEPTION: box or packaging damage disclosed by the seller does NOT penalize conditionHonesty — the condition is about the product not the box, and proactive disclosure is honest; EXCEPTION: official/manufacturer images are normal for new factory-sealed items — do not flag as a discrepancy; EXCEPTION: graded items (PSA, BGS, CGC, etc.) are exempt — the grade IS the certified condition
- shippingFairness (0–100): is shipping reasonable for the item; auto 100 if free; if a cost is present, score on reasonableness relative to item size and price (small flat fee on a high-value item = 90–100, NOT a penalty — never score paid shipping low just because it is not free); if shippingEstimated is true score it normally against the estimate; score 65 (neutral) only if cost is truly unknown
- descriptionQuality (0–100): evaluate against PRODUCT CONTEXT description guidance if provided; otherwise judge on detail, accuracy, and completeness

PRODUCT CONTEXT RULES:
- A structured PRODUCT CONTEXT block may be provided at the end of the listings
- When present, use it as your primary reference for scoring — it contains pre-researched price ranges, condition signals, red flags, and per-score guidance specific to this exact product
- Apply the red flags list to conditionHonesty scoring
- If PRODUCT CONTEXT is absent, fall back to general knowledge

GENERAL RULES:
- Missing data = NEUTRAL (no deduction unless truly critical)
- Describe images in the overview if provided; multiple views of the same item (front, back, sides) are completely normal — do NOT treat as suspicious
- Do NOT use "scam", "suspicious", or "fraud" language from a single signal — only when multiple explicit red flags combine
- DO NOT include numeric scores inside the overview text
- DO NOT add extra fields beyond listingIndex, scores, overview, and highlights

JSON FORMATTING RULES — your output must be valid JSON that passes JSON.parse() without modification:
- Return a single JSON object with one key: "listings"
- Write every "overview" value as a single unbroken line — no literal newline characters inside any string value
- No markdown fences, no backticks, no commentary, no preamble

HIGHLIGHTS RULES:
- First scan the PRODUCT CONTEXT block for accessories and inspection points for this item type. Surface presence as positive, absence as negative.
- Then add clearly observable positive or negative details from title, description, or images — such as shipping, seller reputation, or notable item specifics.
- Do NOT surface the condition label as a highlight. Only flag condition if images visibly contradict the stated condition (e.g. visible damage on a "Like New" claim).
- For shipping: positive if free ("Free shipping"). Negative ONLY if the cost is unreasonably high relative to item price (e.g. $25 shipping on a $30 item). Do NOT generate a shipping highlight at all if the cost is reasonable — having a small flat fee is normal, not a flaw.
- Output 3–6 highlights per listing. Labels ≤10 words, factual.
- Order by importance — most buyer-relevant facts first. The first two will be featured on search cards.
- Examples: "Original box included", "Charger included", "Free shipping", "Top-rated seller", "Missing accessories", "Visible wear in images"
- Only include highlights with clear evidence. Do NOT pad.

OUTPUT FORMAT — return ONLY this JSON object:
{
  "listings": [
    {
      "listingIndex": 0,
      "scores": { "priceFairness": <n>, "conditionHonesty": <n>, "shippingFairness": <n>, "descriptionQuality": <n> },
      "overview": "Short reasoning paragraph.",
      "highlights": [{ "label": "...", "positive": true }]
    }
  ]
}
`.trim();

const MAX_IMAGES_PER_BATCH = 5;

// In stitch mode a listing's photos are collapsed into a single composite image,
// so each listing costs exactly 1 image block regardless of how many photos it has.
type BatchEntry = { listing: any; imageCount: number; stitched?: StitchResult | null };

function getListingImageUrls(listing: any): string[] {
  return (
    Array.isArray(listing.imageUrls)
      ? listing.imageUrls
      : Array.isArray(listing.images)
        ? listing.images
        : []
  ).filter((u: any) => typeof u === "string" && u.trim());
}

async function fetchImageBuffer(url: string): Promise<Buffer | null> {
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 8_000);
    const res = await fetch(url, { signal: controller.signal as any });
    clearTimeout(timer);
    if (!res.ok) return null;
    const ct = res.headers.get("content-type") || "";
    if (ct && !ct.toLowerCase().startsWith("image/")) return null;
    const buf = Buffer.from(await res.arrayBuffer());
    return buf.length > 0 ? buf : null;
  } catch {
    return null;
  }
}

/** Fetch + stitch a listing's photos into one grid image. Returns null if nothing decodes. */
async function stitchListing(listing: any): Promise<StitchResult | null> {
  const urls = getListingImageUrls(listing).slice(0, MAX_IMAGES_PER_BATCH);
  if (urls.length === 0) return null;
  const buffers = (await Promise.all(urls.map(fetchImageBuffer))).filter((b): b is Buffer => b !== null);
  if (buffers.length === 0) return null;
  return stitchBuffers(buffers);
}

function buildImageAwareBatches(entries: BatchEntry[]): BatchEntry[][] {
  const batches: BatchEntry[][] = [];
  let current: BatchEntry[] = [];
  let currentTotal = 0;

  for (const entry of entries) {
    const imgCount = entry.imageCount;

    if (imgCount === 0) {
      // No images — always fits, just append
      current.push(entry);
      continue;
    }

    if (currentTotal + imgCount <= MAX_IMAGES_PER_BATCH) {
      current.push(entry);
      currentTotal += imgCount;
    } else {
      if (current.length > 0) batches.push(current);
      current = [entry];
      currentTotal = imgCount;
    }
  }

  if (current.length > 0) batches.push(current);
  return batches;
}

async function _runEbayBatch(entries: BatchEntry[], context?: string | null, systemPrompt?: string | null): Promise<string[]> {
  const contentParts: any[] = [];
  const listings = entries.map((e) => e.listing);

  for (let i = 0; i < entries.length; i++) {
    const { listing, imageCount } = entries[i];
    const title = clean(listing.title) ?? "Untitled";
    const currency = clean(listing.currency) ?? "USD";
    const link = clean(listing.link ?? listing.url) ?? "";
    const seller = clean(listing.seller) ?? "N/A";
    const feedbackLine = formatFeedback(listing);
    const condition = clean(listing.condition) ?? "N/A";
    const conditionDescriptor = clean(listing.conditionDescriptor) ?? "N/A";
    const itemLocation = formatLocation(listing);
    const buyingOptions = formatBuyingOptions(listing.buyingOptions);
    const shippingLine = formatShippingLine(listing);
    const shortDesc = clean(listing.shortDescription) ?? "";
    const rawDesc = listing.description || listing.fullDescription || "";
    const description = clean(stripHtml(rawDesc)) ?? "";
    const stitched = entries[i].stitched ?? null;
    const imageUrls = getListingImageUrls(listing).slice(0, imageCount);

    const isVariation = isVariationListing(listing);
    const suggestedPriceFairness = isVariation ? null : calculatePriceFairness(listing.price, context, listing.priceLow, listing.priceHigh);

    contentParts.push({ type: "text", text: `=== LISTING ${i + 1} ===` });
    contentParts.push({ type: "text", text: `Title: ${title}` });
    contentParts.push({ type: "text", text: isVariation ? `Price: VARIES — variation listing; price depends on selected option` : `Price: ${listing.price} ${currency}` });
    contentParts.push({ type: "text", text: `Seller: ${seller}` });
    contentParts.push({ type: "text", text: `Feedback: ${feedbackLine}` });
    contentParts.push({ type: "text", text: `Condition: ${condition}` });
    contentParts.push({ type: "text", text: `Condition Descriptor: ${conditionDescriptor}` });
    contentParts.push({ type: "text", text: `Item Location: ${itemLocation}` });
    contentParts.push({ type: "text", text: `Buying Options: ${buyingOptions}` });
    contentParts.push({ type: "text", text: `Shipping: ${shippingLine}` });
    contentParts.push({ type: "text", text: `Original Price: ${formatOriginalPrice(listing.marketingPrice)}` });
    contentParts.push({ type: "text", text: `Discount: ${formatDiscount(listing.marketingPrice)}` });
    contentParts.push({ type: "text", text: `Short Description: ${shortDesc}` });
    contentParts.push({ type: "text", text: `Description: ${description}` });
    contentParts.push({ type: "text", text: `Listing URL: ${link}` });
    contentParts.push({ type: "text", text: `Images Provided: ${stitched ? stitched.cellCount : imageUrls.length}` });
    contentParts.push({ type: "text", text: `Suggested Price Fairness: ${isVariation ? "N/A — variation listing" : (suggestedPriceFairness ?? "N/A")}` });
    if (isVariation) {
      contentParts.push({ type: "text", text: `IMPORTANT: Variation listing — do NOT include priceFairness in this listing's scores. Omit the key. Score only: conditionHonesty, shippingFairness, descriptionQuality.` });
    }

    if (stitched) {
      contentParts.push({ type: "text", text: `[Image grid for Listing ${i + 1}] ${gridLayoutNote(stitched.cols, stitched.rows, stitched.cellCount)}` });
      contentParts.push({ type: "image_url", image_url: { url: stitched.dataUrl } });
    } else if (imageUrls.length > 0) {
      contentParts.push({ type: "text", text: `[Images for Listing ${i + 1}]` });
      for (const url of imageUrls) {
        contentParts.push({ type: "image_url", image_url: { url } });
      }
    }

    contentParts.push({ type: "text", text: `=== END LISTING ${i + 1} ===` });
  }

  if (context) {
    contentParts.push({ type: "text", text: `\n--- PRODUCT CONTEXT ---\n${context}\n--- END PRODUCT CONTEXT ---` });
  }

  const systemContent = systemPrompt
    ? `${systemPrompt}\n\n${EBAY_BATCH_OUTPUT_FORMAT}`
    : EBAY_BATCH_SYSTEM_PROMPT;

  let rawResponse: string;
  try {
    const response = await groqWithRetry(() => groq.chat.completions.create({
      model: "meta-llama/llama-4-scout-17b-16e-instruct",
      messages: [
        { role: "system", content: systemContent },
        { role: "user", content: contentParts },
      ],
      max_tokens: Math.min(listings.length * 800, 5000),
      temperature: 0.2,
      response_format: { type: "json_object" },
    }));
    rawResponse = response.choices[0].message.content?.trim() ?? "{}";
    console.log(`[ebay:batch] response_format=json_object received ${rawResponse.length} chars`);
  } catch (err) {
    console.error("[ebay:batch] API call failed, falling back to sequential individual calls:", err);
    const results: string[] = [];
    for (const l of listings) {
      results.push(await analyzeListingWithImages(l, context).catch(() => "{}"));
    }
    return results;
  }

  try {
    // Primary: parse the { listings: [...] } wrapper from JSON Object Mode
    let parsed: any[] = [];
    try {
      const top = JSON.parse(rawResponse);
      if (Array.isArray(top?.listings)) {
        parsed = top.listings;
      } else if (Array.isArray(top)) {
        // Model returned a bare array despite the prompt — accept it
        parsed = top;
      }
    } catch {
      // Fallback: brace-depth extraction for malformed responses
      console.warn("[ebay:batch] top-level JSON.parse failed, falling back to extractBatchObjects");
      parsed = extractBatchObjects(rawResponse);
    }

    if (parsed.length === 0) throw new Error("No objects extracted from batch response");

    return listings.map((_, i) => {
      const item = parsed.find((x: any) => x.listingIndex === i) ?? parsed[i];
      if (!item?.scores) {
        console.warn(`[ebay:batch] listing ${i} missing scores — returning empty`);
        return "{}";
      }
      return JSON.stringify({ scores: item.scores, overview: item.overview ?? "", highlights: item.highlights ?? [] });
    });
  } catch (err) {
    console.error("[ebay:batch] response parse failed, falling back to sequential individual calls:", err);
    const results: string[] = [];
    for (const l of listings) {
      results.push(await analyzeListingWithImages(l, context).catch(() => "{}"));
    }
    return results;
  }
}

export async function batchAnalyzeListingsWithImages(listings: any[], context?: string | null, systemPrompt?: string | null, opts?: VisionBatchOpts): Promise<string[]> {
  if (listings.length === 0) return [];

  const stitch = opts?.stitch === true;

  // Build a batch entry per listing. In stitch mode we fetch + collapse each
  // listing's photos into one grid image up front, so it costs a single image block.
  const entries: BatchEntry[] = await Promise.all(
    listings.map(async (listing): Promise<BatchEntry> => {
      const available = getListingImageUrls(listing).length;
      if (stitch) {
        const grid = await stitchListing(listing);
        if (grid) {
          listing.__visionImageStats = { provided: available, attached: grid.cellCount, stitched: true };
          console.warn(`[ebay:visionImages] id=${listing.id ?? "unknown"} stitched=${grid.cellCount} (${grid.cols}x${grid.rows})`);
          return { listing, imageCount: 1, stitched: grid };
        }
        // Stitch failed (no decodable images) — fall through to URL mode
      }
      const attached = Math.min(available, MAX_IMAGES_PER_BATCH);
      listing.__visionImageStats = { provided: available, attached, stitched: false };
      return { listing, imageCount: attached };
    })
  );

  const batches = buildImageAwareBatches(entries);
  const results: string[] = [];
  for (const batch of batches) {
    const batchResults = await _runEbayBatch(batch, context, systemPrompt);
    results.push(...batchResults);
  }
  return results;
}
