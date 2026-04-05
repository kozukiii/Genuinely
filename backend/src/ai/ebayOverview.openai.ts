import OpenAI from "openai";
import dotenv from "dotenv";

dotenv.config({ quiet: true });

const client = new OpenAI({
  apiKey: process.env.GROQ_API_KEY!,
  baseURL: "https://api.groq.com/openai/v1",
});


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

export async function analyzeListingWithImages(listing: any, context?: string | null) {
  const title = clean(listing.title) ?? "Untitled";
  const currency = clean(listing.currency) ?? "USD";
  const link = clean(listing.link ?? listing.url) ?? "";

  const seller = clean(listing.seller) ?? "N/A";
  const feedbackLine = formatFeedback(listing);

  const condition = clean(listing.condition) ?? "N/A";
  const conditionDescriptor = clean(listing.conditionDescriptor) ?? "N/A";

  const itemLocation = formatLocation(listing);
  const buyingOptions = formatBuyingOptions(listing.buyingOptions);
  const shippingOptions = formatShippingOptions(listing.shippingOptions);

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
- sellerTrust (0–100) *based on feedback score and number of ratings*
- conditionHonesty (0–100) *does the description match images, and do they both match the stated condition*
- shippingFairness (0–100) *is the shipping price reasonable for the item and location*
- descriptionQuality (0–100) *is the description detailed, accurate, and well-written*

If shipping is free, automatically give full points (100) for shippingFairness.
If shippingCostType is "CALCULATED" or shipping cost is otherwise unknown, treat shippingFairness as neutral (score 65) — never penalize for calculated shipping.
If the seller has excellent feedback (99%+) and many ratings (1000+), automatically give full points (100) for sellerTrust.

If any field is missing/undefined, treat it as NEUTRAL (no deduction, no reward). Missing data should NEVER lower a score unless it's critical (e.g., description or seller ratings).
ALWAYS INCLUDE A DESCRIPTION OF THE IMAGES IN THE OVERVIEW SECTION (unless none were provided).

🎯 Output Format **MUST ALWAYS BE EXACTLY LIKE THIS**:

{
  "scores": {
    "priceFairness": <number>,
    "sellerTrust": <number>,
    "conditionHonesty": <number>,
    "shippingFairness": <number>,
    "descriptionQuality": <number>
  },
  "overview": "Short reasoning paragraph here."
}

After that JSON block, output:

DEBUG INFO:
<Only the raw fields the user sent>

‼️ DO NOT include any scoring numbers inside the overview text.
‼️ DO NOT add extra fields to the JSON.
‼️ DO NOT wrap JSON in backticks.
`,
    },
    {
      role: "user",
      content: [
        { type: "text", text: `Title: ${title}` },
        { type: "text", text: `Price: ${listing.price} ${currency}` },

        { type: "text", text: `Seller: ${seller}` },
        { type: "text", text: `Feedback: ${feedbackLine}` },

        { type: "text", text: `Condition: ${condition}` },
        { type: "text", text: `Condition Descriptor: ${conditionDescriptor}` },

        { type: "text", text: `Item Location: ${itemLocation}` },
        { type: "text", text: `Buying Options: ${buyingOptions}` },
        { type: "text", text: `Shipping Options: ${shippingOptions}` },

        { type: "text", text: `Original Price: ${formatOriginalPrice(listing.marketingPrice)}` },
        { type: "text", text: `Discount: ${formatDiscount(listing.marketingPrice)}` },

        { type: "text", text: `Short Description: ${shortDesc}` },
        { type: "text", text: `Description: ${description}` },

        { type: "text", text: `Listing URL: ${link}` },
        { type: "text", text: `Images Provided: ${imageUrls.length}` },
        ...(context ? [{ type: "text", text: `\n--- PRODUCT CONTEXT ---\n${context}\n--- END PRODUCT CONTEXT ---` }] : []),
      ],
    },
  ];

  for (const url of imageUrls.slice(0, 5)) {
    messages[1].content.push({
      type: "image_url",
      image_url: { url },
    });
  }

  const response = await client.chat.completions.create({
    model: "meta-llama/llama-4-scout-17b-16e-instruct",
    messages,
    max_tokens: 1000,
    temperature: 0.2,
  });

  return response.choices[0].message.content?.trim() || "No analysis.";
}

// ---------------------------------------------------------------------------
// Batch analysis — analyzes multiple listings in a single API call
// ---------------------------------------------------------------------------

const EBAY_BATCH_SIZE = 4;

// Appended to any generated system prompt so the output shape stays consistent
const EBAY_BATCH_OUTPUT_FORMAT = `
You will receive multiple eBay listings numbered 1 through N (each wrapped in === LISTING N === / === END LISTING N ===).
Analyze ALL of them and return results as a JSON array.

ALWAYS APPLY:
- sellerTrust auto 100 if 99%+ feedback and 1000+ ratings
- shippingFairness auto 100 if free; score 65 (neutral) if CALCULATED or unknown
- Missing data = NEUTRAL (no deduction unless truly critical)
- Describe images in the overview if provided
- DO NOT include numeric scores inside the overview text
- DO NOT add extra JSON fields

OUTPUT FORMAT — return ONLY a JSON array (no markdown, no backticks):
[
  {
    "listingIndex": 0,
    "scores": { "priceFairness": <n>, "sellerTrust": <n>, "conditionHonesty": <n>, "shippingFairness": <n>, "descriptionQuality": <n> },
    "overview": "Short reasoning paragraph."
  },
  ...one entry per listing, zero-indexed
]
`.trim();

export const EBAY_BATCH_SYSTEM_PROMPT = `
You are an expert AI specializing in evaluating eBay listings for a deal-finding product.

You will receive multiple listings numbered 1 through N (each wrapped in === LISTING N === / === END LISTING N ===).
Analyze ALL of them and return results as a JSON array.

SCORING RULES (apply to every listing):
- priceFairness (0–100): use PRODUCT CONTEXT price range and fairness guidance if provided; otherwise estimate from listing data and your knowledge
- sellerTrust (0–100): based on feedback score and rating count; auto 100 if 99%+ feedback and 1000+ ratings
- conditionHonesty (0–100): cross-reference stated condition against PRODUCT CONTEXT condition signals and images; does the description match what is shown
- shippingFairness (0–100): is shipping reasonable for the item; auto 100 if free; score 65 (neutral) if CALCULATED or unknown — never penalize calculated shipping
- descriptionQuality (0–100): evaluate against PRODUCT CONTEXT description guidance if provided; otherwise judge on detail, accuracy, and completeness

PRODUCT CONTEXT RULES:
- A structured PRODUCT CONTEXT block may be provided at the end of the listings
- When present, use it as your primary reference for scoring — it contains pre-researched price ranges, condition signals, red flags, and per-score guidance specific to this exact product
- Apply the red flags list to conditionHonesty and sellerTrust scoring
- If PRODUCT CONTEXT is absent, fall back to general knowledge

GENERAL RULES:
- Missing data = NEUTRAL (no deduction unless truly critical)
- Describe images in the overview if provided
- DO NOT include numeric scores inside the overview text
- DO NOT add extra JSON fields

OUTPUT FORMAT — return ONLY a JSON array (no markdown, no backticks):
[
  {
    "listingIndex": 0,
    "scores": { "priceFairness": <n>, "sellerTrust": <n>, "conditionHonesty": <n>, "shippingFairness": <n>, "descriptionQuality": <n> },
    "overview": "Short reasoning paragraph."
  },
  ...one entry per listing, zero-indexed
]
`.trim();

async function _runEbayBatch(listings: any[], context?: string | null, systemPrompt?: string | null): Promise<string[]> {
  const contentParts: any[] = [];

  for (let i = 0; i < listings.length; i++) {
    const listing = listings[i];
    const title = clean(listing.title) ?? "Untitled";
    const currency = clean(listing.currency) ?? "USD";
    const link = clean(listing.link ?? listing.url) ?? "";
    const seller = clean(listing.seller) ?? "N/A";
    const feedbackLine = formatFeedback(listing);
    const condition = clean(listing.condition) ?? "N/A";
    const conditionDescriptor = clean(listing.conditionDescriptor) ?? "N/A";
    const itemLocation = formatLocation(listing);
    const buyingOptions = formatBuyingOptions(listing.buyingOptions);
    const shippingOptions = formatShippingOptions(listing.shippingOptions);
    const shortDesc = clean(listing.shortDescription) ?? "";
    const rawDesc = listing.description || listing.fullDescription || "";
    const description = clean(stripHtml(rawDesc)) ?? "";

    const imageUrls: string[] = Array.isArray(listing.imageUrls)
      ? listing.imageUrls.filter((u: any) => typeof u === "string" && u.trim())
      : Array.isArray(listing.images)
        ? listing.images.filter((u: any) => typeof u === "string" && u.trim())
        : [];

    contentParts.push({ type: "text", text: `=== LISTING ${i + 1} ===` });
    contentParts.push({ type: "text", text: `Title: ${title}` });
    contentParts.push({ type: "text", text: `Price: ${listing.price} ${currency}` });
    contentParts.push({ type: "text", text: `Seller: ${seller}` });
    contentParts.push({ type: "text", text: `Feedback: ${feedbackLine}` });
    contentParts.push({ type: "text", text: `Condition: ${condition}` });
    contentParts.push({ type: "text", text: `Condition Descriptor: ${conditionDescriptor}` });
    contentParts.push({ type: "text", text: `Item Location: ${itemLocation}` });
    contentParts.push({ type: "text", text: `Buying Options: ${buyingOptions}` });
    contentParts.push({ type: "text", text: `Shipping Options: ${shippingOptions}` });
    contentParts.push({ type: "text", text: `Original Price: ${formatOriginalPrice(listing.marketingPrice)}` });
    contentParts.push({ type: "text", text: `Discount: ${formatDiscount(listing.marketingPrice)}` });
    contentParts.push({ type: "text", text: `Short Description: ${shortDesc}` });
    contentParts.push({ type: "text", text: `Description: ${description}` });
    contentParts.push({ type: "text", text: `Listing URL: ${link}` });
    contentParts.push({ type: "text", text: `Images Provided: ${imageUrls.length}` });

    const batchImageUrls = imageUrls.slice(0, 2);
    if (batchImageUrls.length) {
      contentParts.push({ type: "text", text: `[Images for Listing ${i + 1}]` });
      for (const url of batchImageUrls) {
        contentParts.push({ type: "image_url", image_url: { url } });
      }
    }

    contentParts.push({ type: "text", text: `=== END LISTING ${i + 1} ===` });
  }

  if (context) {
    contentParts.push({ type: "text", text: `\n--- PRODUCT CONTEXT ---\n${context}\n--- END PRODUCT CONTEXT ---` });
  }

  // When a generated product-expert prompt is provided, use it as the system message
  // and append the output format rules. Otherwise fall back to the static generic prompt.
  const systemContent = systemPrompt
    ? `${systemPrompt}\n\n${EBAY_BATCH_OUTPUT_FORMAT}`
    : EBAY_BATCH_SYSTEM_PROMPT;

  let rawResponse: string;
  try {
    const response = await client.chat.completions.create({
      model: "meta-llama/llama-4-scout-17b-16e-instruct",
      messages: [
        { role: "system", content: systemContent },
        { role: "user", content: contentParts },
      ],
      max_tokens: Math.min(listings.length * 800, 5000),
      temperature: 0.2,
    });
    rawResponse = response.choices[0].message.content?.trim() ?? "[]";
  } catch (err) {
    console.error("eBay batch API call failed, falling back to individual calls:", err);
    return Promise.all(listings.map((l) => analyzeListingWithImages(l, context)));
  }

  try {
    const parsed = JSON.parse(rawResponse);
    if (!Array.isArray(parsed)) throw new Error("Response was not a JSON array");

    return listings.map((_, i) => {
      const item = parsed.find((x: any) => x.listingIndex === i) ?? parsed[i];
      if (!item?.scores) return "No analysis.\nDEBUG INFO:\n(batch item missing)";
      const jsonStr = JSON.stringify({ scores: item.scores, overview: item.overview ?? "" });
      return `${jsonStr}\nDEBUG INFO:\n(batched with ${listings.length} items)`;
    });
  } catch (err) {
    console.error("eBay batch response parse failed, falling back to individual calls:", err);
    return Promise.all(listings.map((l) => analyzeListingWithImages(l, context)));
  }
}

export async function batchAnalyzeListingsWithImages(listings: any[], context?: string | null, systemPrompt?: string | null): Promise<string[]> {
  if (listings.length === 0) return [];

  const results: string[] = [];
  for (let start = 0; start < listings.length; start += EBAY_BATCH_SIZE) {
    const chunk = listings.slice(start, start + EBAY_BATCH_SIZE);
    const chunkResults = await _runEbayBatch(chunk, context, systemPrompt);
    results.push(...chunkResults);
  }
  return results;
}
