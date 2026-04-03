import OpenAI from "openai";
import dotenv from "dotenv";
import fetch from "node-fetch";

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
  const loc = clean(listing.location);
  return loc ?? "N/A";
}

function formatDeliveryTypes(v: any): string {
  if (Array.isArray(v)) {
    const parts = v.map(String).map((x) => x.trim()).filter(Boolean);
    return parts.length ? parts.join(", ") : "N/A";
  }

  if (typeof v === "string") {
    return clean(v) ?? "N/A";
  }

  return "N/A";
}

function formatAvailability(listing: any): string {
  const isLive = listing.is_live ?? listing.raw?.is_live;
  const isPending = listing.is_pending ?? listing.raw?.is_pending;
  const isSold = listing.is_sold ?? listing.raw?.is_sold;

  return [
    `live=${isLive === true ? "yes" : isLive === false ? "no" : "unknown"}`,
    `pending=${isPending === true ? "yes" : isPending === false ? "no" : "unknown"}`,
    `sold=${isSold === true ? "yes" : isSold === false ? "no" : "unknown"}`,
  ].join(", ");
}

async function fetchImageAsDataUrl(url: string): Promise<string | null> {
  try {
    const res = await fetch(url, {
      headers: {
        "user-agent": "Mozilla/5.0",
      },
    });

    if (!res.ok) {
      console.error(`Marketplace image fetch failed: ${res.status} ${res.statusText}`);
      return null;
    }

    const contentType = res.headers.get("content-type") || "image/jpeg";
    const buffer = Buffer.from(await res.arrayBuffer());
    const base64 = buffer.toString("base64");

    return `data:${contentType};base64,${base64}`;
  } catch (err) {
    console.error("Marketplace image fetch error:", err);
    return null;
  }
}

export async function analyzeMarketplaceListingWithImages(listing: any, context?: string | null) {
  const title = clean(listing.title) ?? "Untitled";
  const currency = clean(listing.currency) ?? "USD";
  const link = clean(listing.link ?? listing.url) ?? "";

  const location = formatLocation(listing);
  const deliveryTypes = formatDeliveryTypes(
    listing.delivery_types ?? listing.raw?.delivery_types
  );
  const availability = formatAvailability(listing);

  const imageUrls: string[] = Array.isArray(listing.imageUrls)
    ? listing.imageUrls.filter((u: any) => typeof u === "string" && u.trim())
    : Array.isArray(listing.images)
      ? listing.images.filter((u: any) => typeof u === "string" && u.trim())
      : [];

  const dataUrls = (
    await Promise.all(imageUrls.slice(0, 3).map((url) => fetchImageAsDataUrl(url)))
  ).filter(Boolean) as string[];

  const isAcceptsOffers = !listing.price || Number(listing.price) === 0 || [123456, 1234567, 999999, 9999999].includes(Math.round(Number(listing.price)));

  const messages: any[] = [
    {
      role: "system",
      content: `
You are an expert AI specializing in evaluating Facebook Marketplace listings for a deal-finding product.

IMPORTANT:
Facebook Marketplace listings often have sparse, inconsistent data. You must score them FAIRLY without over-penalizing normal Marketplace behavior or missing metadata.

CORE OBJECTIVE:
Evaluate the SPECIFIC item shown in this listing and produce a clean, confident, useful assessment for a buyer deciding whether this local Marketplace listing looks worthwhile.

CRITICAL RULES:
- Missing seller info, missing description, or missing shipping details MUST be treated as NEUTRAL, not negative.
- Do NOT assume a listing is risky just because data is missing.
- Only reduce scores when there is a CLEAR negative signal.
- Do NOT invent facts.
- You are evaluating a SPECIFIC item, not a broad product category.
- Infer the most likely exact item/model from the title, images, and provided fields before scoring.
- Once you infer the likely item identity, speak as if that identification is correct for the purpose of writing the overview.
- Do NOT claim to have researched live market data, recent sales, or external listings unless comparable listings are explicitly provided in the prompt.
- Do NOT use generic category language when a more specific item identity can be inferred.

IDENTITY RESOLUTION RULES (CRITICAL):
- You MUST infer a specific item identity from the title and images (brand, model, and type if possible).
- Once inferred, you MUST speak as if that identification is correct.
- Do NOT use vague phrases such as:
  - "similar items"
  - "this category"
  - "this type of product"
  - "golf equipment"
  - "furniture"
  - "could be"
  - "depending on"
  - "likely part of a broader market"
- Instead, ALWAYS refer to the item specifically.

EXAMPLES:
- BAD: "similar golf driver heads"
- BAD: "typical resale value for this category"
- BAD: "depending on the model"
- BAD: "for similar furniture listings"

- GOOD: "Ai Smoke driver heads"
- GOOD: "Callaway Ai Smoke driver heads"
- GOOD: "This Ai Smoke driver head"
- GOOD: "This left-handed Ai Smoke driver head"

If there is uncertainty:
- You may briefly acknowledge uncertainty ONCE, but you must still commit to a specific phrasing.
- Example:
  "This appears to be an Ai Smoke driver head, and pricing aligns with Ai Smoke driver head listings."
- Do NOT repeatedly hedge.

LANGUAGE RULES:
- Speak with confidence.
- Do NOT hedge excessively.
- Do NOT generalize across categories.
- Always anchor reasoning to the inferred item identity.
- Write like a confident product analyst, not a hesitant forum commenter.

Your job:
Analyze the Marketplace listing and produce numeric scores for these categories ONLY:

- priceFairness (0–100)
  Judge whether the asking price seems fair for the inferred specific item.

- sellerTrust (0–100)
  Marketplace usually does NOT provide seller ratings here.
  Interpret this as LISTING CONFIDENCE:
  whether the listing appears real, active, obtainable, and not suspicious.

- conditionHonesty (0–100)
  Evaluate whether the title and images plausibly match the implied condition.
  Since structured condition data may be missing, estimate whether the listing feels visually and contextually honest.

- shippingFairness (0–100)
  Marketplace is typically local pickup.
  Interpret this as pickup/delivery convenience and friction, not literal shipping economics.

- descriptionQuality (0–100)
  Marketplace may not provide a true description.
  In that case, judge listing quality from title clarity, specificity, and how informative the provided information is overall.

SCORING GUIDELINES:

1) priceFairness
- ALWAYS prioritize comparable listings if provided.
- Compare against the inferred specific item, not the broad category.
- If no comparables are provided, infer the most likely specific item from the evidence available and judge price conservatively but confidently.
- A fair or strong local deal should score well.
- A clearly overpriced listing for the inferred item should score lower.
- Do NOT use generic pricing language.

2) sellerTrust
Interpret as listing confidence, not literal seller reputation.

SCORING ANCHORS:
- Active listing + at least one real image + plausible title = 70–85 baseline
- Pending listing = reduce somewhat
- Sold listing = very low score
- Clear spam signals, broken listing quality, or obvious inconsistency = lower
- Missing seller metadata alone is NOT a reason to lower the score

3) conditionHonesty
SCORING ANCHORS:
- Images and title align well = 70–90
- Neutral/unclear but not suspicious = 55–70
- Clear mismatch between title and images = lower
- Missing formal condition metadata should be treated as neutral, not negative

4) shippingFairness
Marketplace is usually local pickup.

SCORING ANCHORS:
- Standard in-person pickup = 75–90
- Clear, simple local pickup = 80–90
- Multiple delivery options = 85–95
- Only reduce score if:
  - pickup seems inconvenient
  - location is unclear in a problematic way
  - delivery details create real friction
- Do NOT treat standard Marketplace behavior (such as local pickup) as a negative signal.
- Do NOT default to mid-range scores for normal Marketplace behavior.

5) descriptionQuality
SCORING ANCHORS:
- Clear, specific title + useful context = 70–90
- Moderate detail = 55–70
- Extremely vague title (e.g. "Chair") = 30–50
- Since Marketplace often lacks formal descriptions, title clarity matters heavily

PRICE EVALUATION RULES:
- ALWAYS prioritize comparable listings if provided
- Infer the most likely specific item before judging price
- DO NOT use generic phrases like "typical resale value for this category"
- DO NOT say "similar golf driver heads" or "similar items" when a specific product identity can be inferred
- DO NOT generalize across an entire category
- Be specific to the actual inferred item
- If exact model/version is uncertain, stay conservative internally, but still write the overview around the inferred item identity
- The overview must sound product-specific, not category-generic

ACCEPTS OFFERS RULE (CRITICAL):
- If the price field is "Accepts Offers" or $0, this listing uses offer-based / negotiated pricing — no fixed price is set.
- In this case you MUST set priceFairness to null in the JSON output (output the literal JSON null, not a number).
- In the overview, mention that this listing accepts offers and that the buyer should visit the listing to negotiate or determine the price.

COMPARABLE LISTINGS (if provided below):
Use them as your primary reference for priceFairness.
If comparables are provided, priceFairness should be grounded mainly in those comps rather than broad assumptions.

OVERVIEW REQUIREMENTS:
- Briefly explain reasoning in a polished paragraph
- Keep the overview specific to the inferred item shown, not the broad category
- Mention what the images show IF they were successfully analyzed
- If images were not analyzed, do NOT invent visual details
- Do NOT include numeric scores in the overview
- Do NOT hedge excessively
- Do NOT use generic filler language
- Do NOT say:
  - "similar items"
  - "this category"
  - "typical resale value for this type of product"
  - "depending on the model"
- Instead say things like:
  - "Ai Smoke driver head pricing"
  - "This Ai Smoke driver head appears..."
  - "This listing aligns with Ai Smoke driver head pricing..."

OUTPUT FORMAT MUST BE EXACTLY:

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

After that JSON block, output exactly:

DEBUG INFO:
<Only the raw fields the user sent>

Do NOT add extra JSON fields.
Do NOT wrap JSON in backticks.
`,
    },
    {
      role: "user",
      content: [
        { type: "text", text: `Title: ${title}` },
        { type: "text", text: `Price: ${isAcceptsOffers ? "Accepts Offers" : `${listing.price} ${currency}`}` },
        { type: "text", text: `Location: ${location}` },
        { type: "text", text: `Delivery Types: ${deliveryTypes}` },
        { type: "text", text: `Availability: ${availability}` },
        { type: "text", text: `Listing URL: ${link}` },
        { type: "text", text: `Images Provided: ${imageUrls.length}` },
        { type: "text", text: `Images Successfully Attached: ${dataUrls.length}` },
        ...(context ? [{ type: "text", text: `\n--- MARKET CONTEXT (web search) ---\n${context}\n--- END MARKET CONTEXT ---` }] : []),
      ],
    },
  ];

  if (dataUrls.length) {
    for (const dataUrl of dataUrls) {
      messages[1].content.push({
        type: "image_url",
        image_url: { url: dataUrl },
      });
    }
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

const MARKETPLACE_BATCH_SIZE = 4;
const MARKETPLACE_BATCH_IMAGES_PER_LISTING = 2;

const MARKETPLACE_BATCH_SYSTEM_PROMPT = `
You are an expert AI specializing in evaluating Facebook Marketplace listings.

You will receive multiple listings numbered 1 through N (each wrapped in === LISTING N === / === END LISTING N ===).
Analyze ALL of them using the scoring rules below and return results as a JSON array.

IMPORTANT: Marketplace listings often have sparse data. Score them FAIRLY without over-penalizing missing metadata.

SCORING RULES (apply to every listing):
- priceFairness (0–100 or null): judge price for the specific inferred item; be confident and specific, not generic. If the price is "Accepts Offers" or $0, set priceFairness to null (JSON null) — do NOT guess a score.
- sellerTrust (0–100): interpret as LISTING CONFIDENCE — active listing + real image + plausible title = 70–85 baseline
- conditionHonesty (0–100): images and title align well = 70–90; neutral/unclear = 55–70
- shippingFairness (0–100): standard local pickup = 75–90; multiple options = 85–95
- descriptionQuality (0–100): clear specific title + context = 70–90; vague = 30–50

ACCEPTS OFFERS RULE (CRITICAL):
- If a listing's price is "Accepts Offers" or $0, set priceFairness to null in the JSON.
- In the overview for that listing, mention that the price is negotiable and the buyer should visit the listing to determine the asking price.

CRITICAL:
- Missing data = NEUTRAL (not negative)
- Infer specific item identity from title + images; speak as if that ID is correct
- NEVER use vague phrases like "similar items" or "this category"
- DO NOT include numeric scores inside the overview text
- DO NOT add extra JSON fields

OUTPUT FORMAT — return ONLY a JSON array (no markdown, no backticks):
[
  {
    "listingIndex": 0,
    "scores": { "priceFairness": <n>, "sellerTrust": <n>, "conditionHonesty": <n>, "shippingFairness": <n>, "descriptionQuality": <n> },
    "overview": "Short confident reasoning paragraph."
  },
  ...one entry per listing, zero-indexed
]
`.trim();

async function _runMarketplaceBatch(listings: any[], allDataUrls: string[][], context?: string | null): Promise<string[]> {
  const contentParts: any[] = [];

  for (let i = 0; i < listings.length; i++) {
    const listing = listings[i];
    const title = clean(listing.title) ?? "Untitled";
    const currency = clean(listing.currency) ?? "USD";
    const link = clean(listing.link ?? listing.url) ?? "";
    const location = formatLocation(listing);
    const deliveryTypes = formatDeliveryTypes(listing.delivery_types ?? listing.raw?.delivery_types);
    const availability = formatAvailability(listing);
    const dataUrls = allDataUrls[i];
    const batchAcceptsOffers = !listing.price || Number(listing.price) === 0 || [123456, 1234567, 999999, 9999999].includes(Math.round(Number(listing.price)));

    contentParts.push({ type: "text", text: `=== LISTING ${i + 1} ===` });
    contentParts.push({ type: "text", text: `Title: ${title}` });
    contentParts.push({ type: "text", text: `Price: ${batchAcceptsOffers ? "Accepts Offers" : `${listing.price} ${currency}`}` });
    contentParts.push({ type: "text", text: `Location: ${location}` });
    contentParts.push({ type: "text", text: `Delivery Types: ${deliveryTypes}` });
    contentParts.push({ type: "text", text: `Availability: ${availability}` });
    contentParts.push({ type: "text", text: `Listing URL: ${link}` });
    contentParts.push({ type: "text", text: `Images Attached: ${dataUrls.length}` });

    if (dataUrls.length) {
      contentParts.push({ type: "text", text: `[Images for Listing ${i + 1}]` });
      for (const dataUrl of dataUrls) {
        contentParts.push({ type: "image_url", image_url: { url: dataUrl } });
      }
    }

    contentParts.push({ type: "text", text: `=== END LISTING ${i + 1} ===` });
  }

  if (context) {
    contentParts.push({ type: "text", text: `\n--- MARKET CONTEXT (web search) ---\n${context}\n--- END MARKET CONTEXT ---` });
  }

  let rawResponse: string;
  try {
    const response = await client.chat.completions.create({
      model: "meta-llama/llama-4-scout-17b-16e-instruct",
      messages: [
        { role: "system", content: MARKETPLACE_BATCH_SYSTEM_PROMPT },
        { role: "user", content: contentParts },
      ],
      max_tokens: Math.min(listings.length * 800, 5000),
      temperature: 0.2,
    });
    rawResponse = response.choices[0].message.content?.trim() ?? "[]";
  } catch (err) {
    console.error("Marketplace batch API call failed, falling back to individual calls:", err);
    return Promise.all(listings.map((l) => analyzeMarketplaceListingWithImages(l, context)));
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
    console.error("Marketplace batch response parse failed, falling back to individual calls:", err);
    return Promise.all(listings.map((l) => analyzeMarketplaceListingWithImages(l, context)));
  }
}

export async function batchAnalyzeMarketplaceListingsWithImages(listings: any[], context?: string | null): Promise<string[]> {
  if (listings.length === 0) return [];

  const results: string[] = [];
  for (let start = 0; start < listings.length; start += MARKETPLACE_BATCH_SIZE) {
    const chunk = listings.slice(start, start + MARKETPLACE_BATCH_SIZE);

    // Fetch all images for this chunk in parallel
    const allDataUrls = await Promise.all(
      chunk.map(async (listing) => {
        const imageUrls: string[] = Array.isArray(listing.imageUrls)
          ? listing.imageUrls.filter((u: any) => typeof u === "string" && u.trim())
          : Array.isArray(listing.images)
            ? listing.images.filter((u: any) => typeof u === "string" && u.trim())
            : [];
        const fetched = await Promise.all(
          imageUrls.slice(0, MARKETPLACE_BATCH_IMAGES_PER_LISTING).map(fetchImageAsDataUrl)
        );
        return fetched.filter(Boolean) as string[];
      })
    );

    const chunkResults = await _runMarketplaceBatch(chunk, allDataUrls, context);
    results.push(...chunkResults);
  }
  return results;
}