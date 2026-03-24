import { analyzeListingWithImages } from "../ai/ebayOverview";

// Helper for safe average
function average(nums: Array<number | undefined>) {
  const valid = nums.filter((n): n is number => typeof n === "number" && !isNaN(n));
  if (valid.length === 0) return null;
  return Math.round(valid.reduce((a, b) => a + b, 0) / valid.length);
}

// --- sanitizers (prevents "undefined" strings + double-JSON shipping options) ---
function cleanString(v: any): string | undefined {
  if (v === undefined || v === null) return undefined;
  const s = String(v).trim();
  if (!s) return undefined;

  const lower = s.toLowerCase();
  if (lower === "undefined" || lower === "null" || lower === "n/a") return undefined;

  // special case: "undefined, undefined, undefined"
  if (/^undefined(\s*,\s*undefined)*$/i.test(s)) return undefined;

  return s;
}

function normalizeBuyingOptions(v: any): string[] | undefined {
  if (Array.isArray(v)) return v.map(String).map((x) => x.trim()).filter(Boolean);
  if (typeof v === "string") {
    const parts = v.split(",").map((x) => x.trim()).filter(Boolean);
    return parts.length ? parts : undefined;
  }
  return undefined;
}

function normalizeShippingOptions(v: any): unknown {
  if (v === undefined || v === null) return undefined;

  // If a JSON string got passed through, parse it once
  if (typeof v === "string") {
    const s = v.trim();
    if (!s) return undefined;
    try {
      return JSON.parse(s);
    } catch {
      return s; // not JSON, keep as string
    }
  }

  return v;
}

function extractFirstJsonObject(raw: string): string | null {
  const start = raw.indexOf("{");
  if (start === -1) return null;

  let depth = 0;
  let inString = false;
  let escaped = false;

  for (let i = start; i < raw.length; i++) {
    const ch = raw[i];

    if (inString) {
      if (escaped) {
        escaped = false;
        continue;
      }
      if (ch === "\\") {
        escaped = true;
        continue;
      }
      if (ch === "\"") {
        inString = false;
      }
      continue;
    }

    if (ch === "\"") {
      inString = true;
      continue;
    }

    if (ch === "{") depth++;
    if (ch === "}") {
      depth--;
      if (depth === 0) {
        return raw.slice(start, i + 1);
      }
    }
  }

  return null;
}

function normalizeScore(v: unknown): number | undefined {
  if (typeof v === "number" && !Number.isNaN(v)) return v;
  if (typeof v === "string") {
    const n = Number(v);
    if (!Number.isNaN(n)) return n;
  }
  return undefined;
}

export async function analyzeItemWithAI(merged: any) {
  // Normalize image input
  const images: string[] =
    Array.isArray(merged.images) ? merged.images :
    Array.isArray(merged.imageUrls) ? merged.imageUrls :
    [];

  const imageUrls = images.filter(Boolean);
  const imageUrl = imageUrls[0] ?? "";

  // sanitize fields so we don't feed "undefined" into the prompt
  const title = cleanString(merged.title) ?? "Untitled";
  const currency = cleanString(merged.currency) ?? "USD";
  const link = cleanString(merged.link ?? merged.url) ?? "";

  const seller = cleanString(merged.seller);
  const feedback = cleanString(merged.feedback);

  const condition = cleanString(merged.condition);
  const conditionDescriptor = cleanString(merged.conditionDescriptor);

  // prefer itemLocation if you add it later; fallback to location
  const location = cleanString(merged.itemLocation ?? merged.location);

  const buyingOptions = normalizeBuyingOptions(merged.buyingOptions);
  const shippingOptions = normalizeShippingOptions(merged.shippingOptions);

  const description =
    cleanString(merged.fullDescription) ??
    cleanString(merged.description) ??
    "";

  const analysis = await analyzeListingWithImages({
    title,
    price: merged.price,
    currency,
    link,

    seller,
    feedback,
    score: merged.score,

    condition,
    conditionDescriptor,

    buyingOptions,
    shippingOptions,
    shippingPrice: typeof merged.shippingPrice === "number" ? merged.shippingPrice : undefined,
    location,

    marketingPrice: merged.marketingPrice,

    description,

    imageUrl,
    imageUrls,
  });

  // Extract JSON block ONLY (top section)
  let jsonBlock: any = null;

  try {
    const extracted = extractFirstJsonObject(analysis);
    if (extracted) {
      jsonBlock = JSON.parse(extracted);
    } else {
      console.error("⚠ No JSON block found in AI response.");
      console.log("RAW:", analysis);
    }
  } catch (err) {
    console.error("Failed to parse AI JSON:", err);
    console.log("RAW ANALYSIS:", analysis);
  }

  const rawScores = jsonBlock?.scores || {};
  const scores = {
    priceFairness: normalizeScore(rawScores.priceFairness),
    sellerTrust: normalizeScore(rawScores.sellerTrust),
    conditionHonesty: normalizeScore(rawScores.conditionHonesty),
    shippingFairness: normalizeScore(rawScores.shippingFairness),
    locationRisk: normalizeScore(rawScores.locationRisk),
    descriptionQuality: normalizeScore(rawScores.descriptionQuality),
  };

  const {
    priceFairness,
    sellerTrust,
    conditionHonesty,
    shippingFairness,
    locationRisk,
    descriptionQuality,
  } = scores;

  const aiScore = average([
    priceFairness,
    sellerTrust,
    conditionHonesty,
    shippingFairness,
    locationRisk,
    descriptionQuality,
  ]);

  return {
    aiScore,
    aiScores: scores,
    overview: jsonBlock?.overview || "No overview.",
    debugInfo: analysis.split("DEBUG INFO:")[1]?.trim() || "No debug info.",
    rawAnalysis: analysis,
  };
}

export async function analyzeItemsWithAI(items: any[]) {
  const analyzed = await Promise.all(
    items.map(async (item) => {
      const ai = await analyzeItemWithAI(item);
      return {
        ...item,
        ...ai,
      };
    })
  );

  return analyzed;
}
