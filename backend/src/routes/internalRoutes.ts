import crypto from "crypto";
import { Router } from "express";
import OpenAI from "openai";
import { requireAuth, requireAdmin } from "../middleware/auth";
import { fetchPriceChartingData, findPriceChartingMatch, scrapePriceChartingUrl } from "../priceSources/priceCharting";
import { findStockXMatch } from "../priceSources/stockx";
import {
  STOCKX_AUTHORIZE_URL,
  STOCKX_AUDIENCE,
  STOCKX_SCOPE,
  exchangeAuthCode,
  isStockXConnected,
  disconnectStockX,
} from "../services/stockxToken";
import { getUsageSummary } from "../services/usageLogger";
import { searchEbayNormalized, getEbayItemByNumericId } from "../services/ebayService";
import { getMarketplaceListingByGraphqlForAnalysis } from "../services/marketplaceService";
import { fetchMarketContext } from "../ai/listingContext";
import { batchAnalyzeListingsWithImages } from "../ai/ebayOverview";
import { submitEbayBatch, getEbayBatchStatus } from "../ai/ebayBatchApi";
import { batchAnalyzeMarketplaceListingsWithImages } from "../ai/marketplaceOverview";
import { extractStructuredAnalysis, validateAnalysis } from "../utils/extractStructuredAnalysis";

const router = Router();

const groq = new OpenAI({
  apiKey: process.env.GROQ_API_KEY ?? "",
  baseURL: "https://api.groq.com/openai/v1",
});

// ─── StockX OAuth callback (UNAUTHENTICATED, state-protected) ───────────────
//
// Registered BEFORE the admin auth middleware below, because the StockX redirect
// is a cross-domain top-level navigation (e.g. through an HTTPS tunnel) that
// won't carry our localhost auth cookie. Instead we protect it with a one-time
// `state` token minted by the admin-only /stockx/auth-url route — standard OAuth
// CSRF protection. Without a matching unexpired state, the callback is rejected.
const stockxPendingStates = new Map<string, number>(); // state -> expiry (unix ms)
const STOCKX_STATE_TTL_MS = 10 * 60 * 1000;

function rememberStockxState(state: string) {
  const now = Date.now();
  for (const [s, exp] of stockxPendingStates) if (exp < now) stockxPendingStates.delete(s);
  stockxPendingStates.set(state, now + STOCKX_STATE_TTL_MS);
}

function consumeStockxState(state: string): boolean {
  const exp = stockxPendingStates.get(state);
  if (exp === undefined) return false;
  stockxPendingStates.delete(state);
  return exp >= Date.now();
}

function stockxRedirectUriFor(req: import("express").Request): string {
  if (process.env.STOCKX_REDIRECT_URI) return process.env.STOCKX_REDIRECT_URI;
  return `${req.protocol}://${req.get("host")}/api/internal/stockx/oauth/callback`;
}

// Step 2 of the handshake: StockX redirects the browser here with ?code=&state=.
router.get("/stockx/oauth/callback", async (req, res) => {
  const code = typeof req.query.code === "string" ? req.query.code : "";
  const state = typeof req.query.state === "string" ? req.query.state : "";
  const oauthError = typeof req.query.error === "string" ? req.query.error : "";
  if (oauthError) return res.status(400).send(`StockX OAuth error: ${oauthError}`);
  if (!code) return res.status(400).send("Missing authorization code");
  if (!consumeStockxState(state)) return res.status(403).send("Invalid or expired OAuth state");

  try {
    await exchangeAuthCode(code, stockxRedirectUriFor(req));
    res.redirect(`${process.env.FRONTEND_URL ?? ""}/admin/stockx-debug?connected=1`);
  } catch (err: any) {
    console.error("[stockx] oauth callback error:", err?.message);
    res.status(500).send(`StockX token exchange failed: ${err?.message ?? "unknown error"}`);
  }
});

router.use(requireAuth, requireAdmin);

type ProviderUsage = {
  name: string;
  used: number | null;
  limit: number | null;
  remaining: number | null;
  percentUsed: number | null;
  status: "ok" | "warning" | "critical" | "unknown";
  resetTime?: string | null;
  note?: string | null;
  highlight?: string | null;
};

async function fetchSerperUsage(): Promise<ProviderUsage> {
  const apiKey = process.env.SERPER_API_KEY;
  if (!apiKey) return { name: "Serper", used: null, limit: null, remaining: null, percentUsed: null, status: "unknown", note: "SERPER_API_KEY not set" };

  try {
    const r = await fetch("https://google.serper.dev/account", {
      headers: { "X-API-KEY": apiKey },
      signal: AbortSignal.timeout(5000),
    });
    if (!r.ok) throw new Error(`${r.status}`);
    // Response shape: { balance: number (credits remaining), rateLimit: number }
    const data = await r.json() as { balance?: number; rateLimit?: number };

    const remaining   = data.balance ?? null;
    const limit       = 50_000;
    const used        = remaining !== null ? limit - remaining : null;
    const percentUsed = used !== null ? Math.round((used / limit) * 100) : null;

    return {
      name: "Serper",
      used,
      limit,
      remaining,
      percentUsed,
      status: remaining === null ? "unknown" : remaining > 1000 ? "ok" : remaining > 200 ? "warning" : "critical",
      note: `${remaining?.toLocaleString()} of ${limit.toLocaleString()} credits remaining`,
    };
  } catch (e: any) {
    return { name: "Serper", used: null, limit: null, remaining: null, percentUsed: null, status: "unknown", note: e.message };
  }
}

// Groq pricing: USD per 1M tokens (input / output)
const GROQ_PRICING: Record<string, { input: number; output: number }> = {
  "llama-3.1-8b-instant":  { input: 0.05,  output: 0.08  },
  "llama-4-scout-17b":     { input: 0.11,  output: 0.34  },
};
const GROQ_DEFAULT_PRICE = { input: 0.10, output: 0.10 };

function groqCost(model: string, promptTokens: number, completionTokens: number): number {
  const p = GROQ_PRICING[model] ?? GROQ_DEFAULT_PRICE;
  return (promptTokens / 1_000_000) * p.input + (completionTokens / 1_000_000) * p.output;
}

function fetchGroqUsage(): ProviderUsage {
  const rows = getUsageSummary().filter(r => r.provider === "groq");
  const totalCalls = rows.reduce((s, r) => s + r.calls, 0);

  if (totalCalls === 0) {
    return { name: "Groq", used: null, limit: null, remaining: null, percentUsed: null, status: "unknown", note: "No calls logged yet" };
  }

  const totalCost   = rows.reduce((s, r) => s + groqCost(r.model, r.prompt_tokens, r.completion_tokens), 0);
  const totalTokens = rows.reduce((s, r) => s + r.total_tokens, 0);
  const breakdown   = rows.map(r => {
    const cost = groqCost(r.model, r.prompt_tokens, r.completion_tokens);
    return `${r.model}: ${r.total_tokens.toLocaleString()} tok · $${cost.toFixed(4)} (${r.calls} calls)`;
  }).join("\n");

  return {
    name: "Groq",
    used: totalTokens,
    limit: null,
    remaining: null,
    percentUsed: null,
    status: "ok",
    highlight: `$${totalCost.toFixed(4)}`,
    note: breakdown,
  };
}

async function fetchProxyCheapUsage(): Promise<ProviderUsage> {
  const apiKey    = process.env.PROXYCHEAP_API_KEY;
  const apiSecret = process.env.PROXYCHEAP_API_SECRET;
  if (!apiKey || !apiSecret) return { name: "ProxyCheap", used: null, limit: null, remaining: null, percentUsed: null, status: "unknown", note: "PROXYCHEAP_API_KEY / PROXYCHEAP_API_SECRET not set" };

  try {
    const r = await fetch("https://api.proxy-cheap.com/proxies", {
      headers: { "X-Api-Key": apiKey, "X-Api-Secret": apiSecret },
      signal: AbortSignal.timeout(5000),
    });
    if (!r.ok) throw new Error(`${r.status}`);
    const data = await r.json() as { proxies?: { bandwidth?: { total: number | null; used: number } }[] };
    const proxies = data.proxies ?? [];

    // Sum across all proxies; bandwidth values are in GB
    const totalGB = proxies.reduce((s, p) => s + (p.bandwidth?.total ?? 0), 0);
    const usedGB  = proxies.reduce((s, p) => s + (p.bandwidth?.used ?? 0), 0);
    const usedMB  = Math.round(usedGB * 1024);
    const totalMB = Math.round(totalGB * 1024);
    const percentUsed = totalMB > 0 ? Math.round((usedMB / totalMB) * 100) : null;

    const status: ProviderUsage["status"] =
      percentUsed === null ? "unknown" :
      percentUsed < 75     ? "ok" :
      percentUsed < 90     ? "warning" :
                             "critical";

    return {
      name: "ProxyCheap",
      used: usedMB,
      limit: totalMB,
      remaining: totalMB - usedMB,
      percentUsed,
      status,
      note: `${usedMB} MB used of ${totalGB} GB`,
    };
  } catch (e: any) {
    return { name: "ProxyCheap", used: null, limit: null, remaining: null, percentUsed: null, status: "unknown", note: e.message };
  }
}

router.get("/usage", async (_req, res) => {
  const [serper, proxycheap] = await Promise.all([
    fetchSerperUsage(),
    fetchProxyCheapUsage(),
  ]);
  const groq = fetchGroqUsage();

  res.json({ providers: [serper, groq, proxycheap] });
});

// ─── Grid-stitch A/B comparison (admin debug) ───────────────────────────────
//
// Rugged side-by-side harness for the image-grid-stitching experiment. Fetches
// the given listings, scores them BOTH ways (per-image vs. one stitched grid per
// listing) using identical prompts/context, and returns both score sets so we can
// eyeball whether stitching degrades the detail-sensitive scores (conditionHonesty).

const EBAY_KEYS = new Set(["priceFairness", "conditionHonesty", "shippingFairness", "descriptionQuality"]);
const MP_KEYS = new Set(["priceFairness", "sellerTrust", "conditionHonesty", "shippingFairness", "descriptionQuality"]);

function parseScores(raw: string, keys: Set<string>) {
  const extracted = extractStructuredAnalysis(raw);
  const validated = extracted ? validateAnalysis(extracted, keys) : null;
  return {
    scores: validated?.scores ?? null,
    overview: validated?.overview ?? "",
    highlights: validated?.highlights ?? [],
  };
}

// POST { source: "ebay"|"marketplace", ids: string[] }
// Scores every listing twice (stitch off / stitch on) with no product context,
// so the only variable is the image packing strategy.
// Accept a bare numeric id OR a pasted eBay/Marketplace listing URL.
function extractListingId(raw: string, source: "ebay" | "marketplace"): string | null {
  const ebayMatch = raw.match(/ebay\.com\/itm\/(?:[^/?#]+\/)?(\d{8,})/);
  if (ebayMatch) return ebayMatch[1];
  const mpMatch = raw.match(/facebook\.com\/marketplace\/item\/(\d+)/);
  if (mpMatch) return mpMatch[1];
  const bare = raw.match(/^\d{6,}$/) ? raw : raw.match(/(\d{6,})/)?.[1];
  return bare ?? null;
}

router.post("/grid-compare/run", async (req, res) => {
  const source = req.body?.source === "marketplace" ? "marketplace" : "ebay";
  const ids: string[] = Array.isArray(req.body?.ids)
    ? req.body.ids
        .map((x: any) => extractListingId(String(x).trim(), source))
        .filter((x: string | null): x is string => !!x)
    : [];

  if (ids.length === 0) return res.status(400).json({ error: "ids must be a non-empty array (numeric IDs or listing URLs)" });
  if (ids.length > 10) return res.status(400).json({ error: "max 10 listings per run" });

  try {
    // Fetch each listing
    const fetched = await Promise.all(
      ids.map(async (id) => {
        try {
          const listing = source === "ebay"
            ? await getEbayItemByNumericId(id)
            : await getMarketplaceListingByGraphqlForAnalysis(id);
          return { id, listing };
        } catch (err: any) {
          return { id, listing: null, error: err?.message ?? "fetch failed" };
        }
      })
    );

    const listings = fetched.filter((f) => f.listing).map((f) => f.listing);
    if (listings.length === 0) {
      return res.status(502).json({ error: "no listings could be fetched", fetched });
    }

    const keys = source === "ebay" ? EBAY_KEYS : MP_KEYS;
    const runBatch = source === "ebay"
      ? batchAnalyzeListingsWithImages
      : batchAnalyzeMarketplaceListingsWithImages;

    // Fresh clones per run so __visionImageStats from one run can't leak into the other
    const clone = (arr: any[]) => arr.map((l) => structuredClone(l));

    const perImageInput = clone(listings);
    const t0 = Date.now();
    const perImageRaw = await runBatch(perImageInput, null, null, { stitch: false });
    const perImageMs = Date.now() - t0;

    const stitchedInput = clone(listings);
    const t1 = Date.now();
    const stitchedRaw = await runBatch(stitchedInput, null, null, { stitch: true });
    const stitchedMs = Date.now() - t1;

    const results = listings.map((listing: any, i: number) => ({
      id: ids[fetched.findIndex((f) => f.listing === listing)] ?? listing.id ?? null,
      title: listing.title ?? null,
      url: listing.link ?? listing.url ?? null,
      imageUrls: (Array.isArray(listing.imageUrls) ? listing.imageUrls : listing.images ?? []).slice(0, 8),
      perImage: { ...parseScores(perImageRaw[i] ?? "{}", keys), stats: perImageInput[i]?.__visionImageStats ?? null },
      stitched: { ...parseScores(stitchedRaw[i] ?? "{}", keys), stats: stitchedInput[i]?.__visionImageStats ?? null },
    }));

    return res.json({
      source,
      timing: { perImageMs, stitchedMs },
      fetchErrors: fetched.filter((f) => !f.listing),
      results,
    });
  } catch (err: any) {
    console.error("[grid-compare] error:", err);
    return res.status(500).json({ error: err?.message ?? "compare failed" });
  }
});

// ─── eBay Batch API test harness (admin debug) ──────────────────────────────
//
// A/B comparison of the synchronous analysis route vs. Groq's async Batch API.
// To make the comparison a TRUE click→populated-UI measurement, the search runs
// ONCE up front (shared prep, excluded from the timers), then the client fires
// /sync-analyze and /batch-submit IN PARALLEL from a single t0 and times each
// column to when it actually renders. Neither path gates the other.

// runId -> the fetched listings, so both parallel calls score the SAME listings.
const ebayRunListings = new Map<string, { query: string; listings: any[]; createdAt: number }>();
// batchId -> batch run state for status polling.
const ebayBatchMeta = new Map<string, { query: string; submittedAt: number; completedAt: number | null }>();
type EbayContextScheme = "serper" | "groq";
const ebayRunContexts = new Map<string, Partial<Record<EbayContextScheme, { context: string | null; elapsedMs: number; tokens: number | null }>>>();

// Evict run/batch entries older than this so the admin maps don't grow unbounded.
const EBAY_RUN_TTL_MS = 60 * 60 * 1000;
function pruneEbayRuns() {
  const cutoff = Date.now() - EBAY_RUN_TTL_MS;
  for (const [k, v] of ebayRunListings) if (v.createdAt < cutoff) ebayRunListings.delete(k);
  for (const [k, v] of ebayBatchMeta) if (v.submittedAt < cutoff) ebayBatchMeta.delete(k);
  for (const k of ebayRunContexts.keys()) if (!ebayRunListings.has(k)) ebayRunContexts.delete(k);
}

// Step 1 — shared search. Fetches listings once and stashes them under a runId.
router.post("/ebay-batch-test/search", async (req, res) => {
  const query = typeof req.body?.query === "string" ? req.body.query.trim() : "";
  const limit = Math.min(Math.max(Number(req.body?.limit) || 8, 1), 20);
  if (!query) return res.status(400).json({ error: "query is required" });

  try {
    pruneEbayRuns();
    const listings = await searchEbayNormalized(query, limit);
    if (listings.length === 0) return res.status(404).json({ error: "no eBay listings found for query" });

    const runId = crypto.randomUUID();
    ebayRunListings.set(runId, { query, listings, createdAt: Date.now() });

    return res.json({
      runId,
      query,
      count: listings.length,
      listings: listings.map((l: any) => ({
        title: l.title ?? null,
        url: l.link ?? l.url ?? null,
        price: l.price ?? null,
        currency: l.currency ?? "USD",
        condition: l.condition ?? null,
        image: (Array.isArray(l.imageUrls) ? l.imageUrls[0] : Array.isArray(l.images) ? l.images[0] : null) ?? null,
      })),
    });
  } catch (err: any) {
    console.error("[ebay-batch-test] search error:", err);
    return res.status(500).json({ error: err?.message ?? "search failed" });
  }
});

// Step 2a — synchronous route. Returns when scoring is done (the response IS the paint).
function storeEbayContext(runId: string, scheme: EbayContextScheme, value: { context: string | null; elapsedMs: number; tokens: number | null }) {
  const existing = ebayRunContexts.get(runId) ?? {};
  existing[scheme] = value;
  ebayRunContexts.set(runId, existing);
}

router.post("/ebay-batch-test/context/serper", async (req, res) => {
  const runId = typeof req.body?.runId === "string" ? req.body.runId : "";
  const run = ebayRunListings.get(runId);
  if (!run) return res.status(404).json({ error: "unknown or expired runId" });

  try {
    const startedAt = Date.now();
    const context = await fetchMarketContext(run.query);
    const payload = { context, elapsedMs: Date.now() - startedAt, tokens: null };
    storeEbayContext(runId, "serper", payload);
    return res.json({ scheme: "serper", ...payload });
  } catch (err: any) {
    console.error("[ebay-batch-test] serper context error:", err);
    return res.status(500).json({ error: err?.message ?? "serper context failed" });
  }
});

router.post("/ebay-batch-test/context/groq", async (req, res) => {
  const runId = typeof req.body?.runId === "string" ? req.body.runId : "";
  const run = ebayRunListings.get(runId);
  if (!run) return res.status(404).json({ error: "unknown or expired runId" });

  try {
    const startedAt = Date.now();
    const titles = run.listings
      .map((listing: any, i: number) => `${i + 1}. ${listing.title ?? "Untitled"} (${listing.price ?? "unknown"} ${listing.currency ?? "USD"})`)
      .join("\n");
    const response = await groq.chat.completions.create({
      model: "groq/compound-mini",
      messages: [
        {
          role: "system",
          content: "You create concise product market context for marketplace listing scoring. Use web search when useful. Return plain text only, no markdown fences.",
        },
        {
          role: "user",
          content: `Search query: ${run.query}\n\nListings:\n${titles}\n\nCreate a concise PRODUCT CONTEXT block for scoring these eBay listings. Include used resale price range in USD, common included accessories, condition inspection points, and red flags. Keep it under 350 words.`,
        },
      ],
      temperature: 0,
      max_tokens: 700,
    });
    const context = response.choices[0]?.message?.content?.trim() || null;
    const payload = {
      context,
      elapsedMs: Date.now() - startedAt,
      tokens: response.usage?.total_tokens ?? null,
    };
    storeEbayContext(runId, "groq", payload);
    return res.json({ scheme: "groq", ...payload });
  } catch (err: any) {
    console.error("[ebay-batch-test] groq context error:", err);
    return res.status(500).json({ error: err?.message ?? "groq context failed" });
  }
});

router.post("/ebay-batch-test/sync-analyze", async (req, res) => {
  const runId = typeof req.body?.runId === "string" ? req.body.runId : "";
  const run = ebayRunListings.get(runId);
  if (!run) return res.status(404).json({ error: "unknown or expired runId" });

  try {
    // Cloned so __visionImageStats can't leak into the batch-API listings.
    const syncInput = run.listings.map((l: any) => structuredClone(l));
    const syncStart = Date.now();
    const syncRaw = await batchAnalyzeListingsWithImages(syncInput, null, null, { stitch: false });
    const syncMs = Date.now() - syncStart;
    const results = syncRaw.map((raw, i) => ({ index: i, ...parseScores(raw, EBAY_KEYS) }));
    return res.json({ serverMs: syncMs, results });
  } catch (err: any) {
    console.error("[ebay-batch-test] sync-analyze error:", err);
    return res.status(500).json({ error: err?.message ?? "sync-analyze failed" });
  }
});

// Step 2b — batch submit. Returns a batchId fast; the client then polls /status.
router.post("/ebay-batch-test/batch-submit", async (req, res) => {
  const runId = typeof req.body?.runId === "string" ? req.body.runId : "";
  const scheme: EbayContextScheme = req.body?.scheme === "groq" ? "groq" : "serper";
  const run = ebayRunListings.get(runId);
  if (!run) return res.status(404).json({ error: "unknown or expired runId" });

  try {
    const context = ebayRunContexts.get(runId)?.[scheme]?.context ?? null;
    const batchId = await submitEbayBatch(run.listings, context);
    ebayBatchMeta.set(batchId, { query: `${run.query} (${scheme})`, submittedAt: Date.now(), completedAt: null });
    return res.json({ batchId, scheme });
  } catch (err: any) {
    console.error("[ebay-batch-test] batch-submit error:", err);
    return res.status(500).json({ error: err?.message ?? "batch-submit failed" });
  }
});

router.get("/ebay-batch-test/status", async (req, res) => {
  const batchId = typeof req.query.id === "string" ? req.query.id : "";
  if (!batchId) return res.status(400).json({ error: "id is required" });

  try {
    const status = await getEbayBatchStatus(batchId);
    const meta = ebayBatchMeta.get(batchId);

    // Freeze the batch timer the first time we observe a terminal state.
    const terminal = ["completed", "failed", "expired", "cancelled"].includes(status.status);
    if (meta && terminal && meta.completedAt === null) meta.completedAt = Date.now();
    const elapsedMs = meta ? (meta.completedAt ?? Date.now()) - meta.submittedAt : null;

    return res.json({ ...status, query: meta?.query ?? null, elapsedMs });
  } catch (err: any) {
    console.error("[ebay-batch-test] status error:", err);
    return res.status(500).json({ error: err?.message ?? "status failed" });
  }
});

router.get("/ebay/sold-prices", async (req, res) => {
  const query = typeof req.query.query === "string" ? req.query.query.trim() : "";
  const limitParam = typeof req.query.limit === "string" ? Number(req.query.limit) : 50;
  const marketplaceId = typeof req.query.marketplaceId === "string" && req.query.marketplaceId.trim()
    ? req.query.marketplaceId.trim()
    : "EBAY_US";

  if (!query) {
    return res.status(400).json({ error: "Missing query parameter" });
  }

  try {
    const data = await fetchPriceChartingData(query, limitParam, marketplaceId);
    return res.json(data);
  } catch (err: any) {
    console.error("eBay sold prices error:", err);
    const message = err?.message ?? "Failed to fetch eBay sold prices";
    return res.status(500).json({ error: message });
  }
});

router.get("/pricecharting/match-title", async (req, res) => {
  const title = typeof req.query.title === "string" ? req.query.title.trim() : "";
  if (!title) return res.status(400).json({ error: "Missing title parameter" });

  try {
    console.log(`[pricecharting-debug] match-title title="${title}"`);
    const result = await findPriceChartingMatch(title);
    console.log(`[pricecharting-debug] result found=${result.found} candidates=${result.attemptedQueries.length}`);
    result.debugLines?.forEach((line) => console.log(`[pricecharting-debug] ${line}`));
    return res.json(result);
  } catch (err: any) {
    const message = err?.message ?? "Match failed";
    console.error("[pricecharting-debug] match-title error:", message);
    return res.status(500).json({ error: message, debugLines: [message] });
  }
});

router.get("/ebay/listing-titles", async (req, res) => {
  const query = typeof req.query.query === "string" ? req.query.query.trim() : "";
  const limit = typeof req.query.limit === "string" ? Math.min(Number(req.query.limit) || 50, 100) : 50;

  if (!query) return res.status(400).json({ error: "Missing query parameter" });

  try {
    const listings = await searchEbayNormalized(query, limit);
    console.log(`[pricecharting-debug] ebay/listing-titles query="${query}" returned=${listings.length}`);
    return res.json({
      titles: listings.map((listing) => ({
        id: listing.id,
        title: listing.title,
        imageUrl: listing.images[0] ?? null,
      })),
    });
  } catch (err: any) {
    return res.status(500).json({ error: err?.message ?? "Failed to fetch eBay listings" });
  }
});

router.get("/serper/source-match", async (req, res) => {
  const title = typeof req.query.title === "string" ? req.query.title.trim() : "";
  if (!title) return res.status(400).json({ error: "Missing title parameter" });

  const apiKey = process.env.SERPER_API_KEY;
  if (!apiKey) return res.status(500).json({ error: "SERPER_API_KEY not configured", debugLines: ["SERPER_API_KEY not set"] });

  const debugLines: string[] = [];

  // Strip non-ASCII and punctuation noise before searching
  const cleanTitle = title
    .replace(/[^\x20-\x7E]/g, " ")   // drop non-ASCII (emojis, fancy quotes, etc.)
    .replace(/[^a-zA-Z0-9\s'\/#+.]/g, " ")  // keep letters, numbers, card-number chars
    .replace(/\s{2,}/g, " ")
    .trim();

  try {
    debugLines.push(`Serper search (cleaned): "${cleanTitle}" (original: "${title}"`);
    const serperRes = await fetch("https://google.serper.dev/search", {
      method: "POST",
      headers: { "X-API-KEY": apiKey, "Content-Type": "application/json" },
      body: JSON.stringify({ q: cleanTitle, num: 10 }),
      signal: AbortSignal.timeout(8000),
    });
    if (!serperRes.ok) throw new Error(`Serper HTTP ${serperRes.status}`);

    const serperData = await serperRes.json() as { organic?: { title?: string; link?: string; snippet?: string }[] };
    const organic = serperData.organic ?? [];
    debugLines.push(`Got ${organic.length} organic results`);
    organic.forEach((r, i) => debugLines.push(`  [${i}] ${r.link ?? "(no link)"}`));

    const pcResult = organic.find((r) => r.link && /pricecharting\.com\/game\//i.test(r.link));
    if (!pcResult?.link) {
      debugLines.push("No PriceCharting /game/ link found in Serper results");
      return res.json({ found: false, debugLines });
    }

    debugLines.push(`Found PC link: ${pcResult.link}`);
    const scraped = await scrapePriceChartingUrl(pcResult.link, title);
    debugLines.push(`Scraped title: ${scraped.title}`);
    debugLines.push(`Grade detected: ${scraped.grade ?? "none"}`);
    debugLines.push(`Prices — loose: ${scraped.loosePrice}, complete: ${scraped.completePrice}, new: ${scraped.newPrice}, graded: ${scraped.gradedPrice}, tcgplayer: ${scraped.tcgPlayerPrice}`);
    debugLines.push(`Graded sales found: ${scraped.gradedSalePrices.length} — [${scraped.gradedSalePrices.join(", ")}]`);
    debugLines.push(`Graded sales range: low=${scraped.gradedSaleLow}, high=${scraped.gradedSaleHigh}`);

    // Compute chart bounds
    let chartLow: number | null = null;
    let chartHigh: number | null = null;
    if (scraped.grade !== null) {
      // Graded card — use only PriceCharting graded sale data, never mix in TCGPlayer
      if (scraped.gradedSaleLow !== null && scraped.gradedSaleHigh !== null) {
        chartLow = scraped.gradedSaleLow;
        chartHigh = scraped.gradedSaleHigh;
      } else if (scraped.gradedPrice !== null) {
        // No individual sales found — use the aggregate graded price for both ends
        chartLow = scraped.gradedPrice;
        chartHigh = scraped.gradedPrice;
      }
    } else {
      // Non-graded: low = min(loose, tcgplayer), high = max(loose, tcgplayer)
      const candidates = [scraped.loosePrice, scraped.tcgPlayerPrice].filter((v): v is number => v !== null);
      if (candidates.length >= 2) {
        chartLow = Math.min(...candidates);
        chartHigh = Math.max(...candidates);
      } else if (candidates.length === 1) {
        chartLow = candidates[0];
        chartHigh = candidates[0];
      }
    }
    debugLines.push(`Chart bounds: low=${chartLow}, high=${chartHigh}`);

    return res.json({
      found: true,
      pcUrl: scraped.url,
      serperTitle: pcResult.title ?? null,
      serperSnippet: pcResult.snippet ?? null,
      scrapedTitle: scraped.title,
      grade: scraped.grade,
      loosePrice: scraped.loosePrice,
      completePrice: scraped.completePrice,
      newPrice: scraped.newPrice,
      gradedPrice: scraped.gradedPrice,
      gradedSaleLow: scraped.gradedSaleLow,
      gradedSaleHigh: scraped.gradedSaleHigh,
      tcgPlayerPrice: scraped.tcgPlayerPrice,
      tcgPlayerUrl: scraped.tcgPlayerUrl,
      chartLow,
      chartHigh,
      debugLines,
    });
  } catch (err: any) {
    const message = err?.message ?? "Match failed";
    debugLines.push(`Error: ${message}`);
    console.error("[serper-source-match] error:", message);
    return res.status(500).json({ error: message, debugLines });
  }
});

// ─── StockX ─────────────────────────────────────────────────────────────────
// (The state-protected OAuth callback is registered near the top of this file,
// before the admin auth middleware, since the StockX redirect can't carry our
// auth cookie cross-domain.)

router.get("/stockx/status", (_req, res) => {
  res.json({ connected: isStockXConnected() });
});

// Forget our stored tokens so the next connect requires a fresh handshake.
router.post("/stockx/disconnect", (_req, res) => {
  disconnectStockX();
  res.json({ connected: false });
});

// Step 1 of the one-time handshake: build the StockX authorize URL to send the
// admin's browser to. Records a one-time `state` the callback will verify.
router.get("/stockx/auth-url", (req, res) => {
  const clientId = process.env.STOCKX_CLIENT_ID;
  if (!clientId) return res.status(500).json({ error: "STOCKX_CLIENT_ID not configured" });

  const state = crypto.randomUUID();
  rememberStockxState(state);

  const params = new URLSearchParams({
    response_type: "code",
    client_id: clientId,
    redirect_uri: stockxRedirectUriFor(req),
    scope: STOCKX_SCOPE,
    audience: STOCKX_AUDIENCE,
    state,
    // NOTE: do NOT send prompt=login here. StockX's OAuth (Auth0) tenant
    // rejects the unsupported param with a generic
    // `error=server_error&error_description=Internal error` redirect before
    // issuing a code. To switch accounts, sign out at stockx.com / use a
    // separate browser session instead.
  });
  res.json({ url: `${STOCKX_AUTHORIZE_URL}?${params}` });
});

router.get("/stockx/match-title", async (req, res) => {
  const title = typeof req.query.title === "string" ? req.query.title.trim() : "";
  if (!title) return res.status(400).json({ error: "Missing title parameter" });

  try {
    console.log(`[stockx-debug] match-title title="${title}"`);
    const result = await findStockXMatch(title);
    console.log(`[stockx-debug] result found=${result.found} ask=${result.lowestAsk} bid=${result.highestBid}`);
    result.debugLines?.forEach((line) => console.log(`[stockx-debug] ${line}`));
    return res.json(result);
  } catch (err: any) {
    const message = err?.message ?? "Match failed";
    console.error("[stockx-debug] match-title error:", message);
    return res.status(500).json({ error: message, debugLines: [message] });
  }
});

export default router;
