// ─── Groq Batch API path for eBay analysis ──────────────────────────────────
//
// Unlike the synchronous batchAnalyzeListingsWithImages (which packs many
// listings into one chat.completions call and shares the real-time TPM bucket),
// this submits one request PER listing to Groq's async Batch API. Batch jobs run
// on a separate rate-limit pool that does NOT count against synchronous TPM, and
// bill at ~50% the token cost. Tradeoff: results are async (minutes–hours), so
// callers submit, then poll.
//
// OpenAI-compatible: we reuse the OpenAI SDK pointed at Groq's base URL.

import OpenAI, { toFile } from "openai";
import dotenv from "dotenv";
import { buildEbayAnalysisMessages } from "./ebayOverview";
import { runRawChatBatch, type RawChatBatchOpts } from "./groqBatchRun";
import { extractStructuredAnalysis, validateAnalysis } from "../utils/extractStructuredAnalysis";

dotenv.config({ quiet: true });

const groq = new OpenAI({
  apiKey: process.env.GROQ_API_KEY!,
  baseURL: "https://api.groq.com/openai/v1",
});

const MODEL = "meta-llama/llama-4-scout-17b-16e-instruct";
const EBAY_KEYS = new Set(["priceFairness", "conditionHonesty", "shippingFairness", "descriptionQuality"]);

/** custom_id we attach to each line so results map back to the listing index. */
function customIdFor(i: number): string {
  return `listing-${i}`;
}
function indexFromCustomId(id: string): number {
  const m = id.match(/^listing-(\d+)$/);
  return m ? Number(m[1]) : -1;
}

/**
 * Submit every listing as its own request in a single Groq Batch job.
 * Returns the batch id to poll. eBay image URLs are public, so we embed them
 * directly (no base64) to keep the JSONL small.
 */
export async function submitEbayBatch(listings: any[], context?: string | null): Promise<string> {
  const lines = listings.map((listing, i) => ({
    custom_id: customIdFor(i),
    method: "POST",
    url: "/v1/chat/completions",
    body: {
      model: MODEL,
      messages: buildEbayAnalysisMessages(listing, context),
      max_tokens: 1000,
      temperature: 0.2,
      response_format: { type: "json_object" },
    },
  }));

  const jsonl = lines.map((l) => JSON.stringify(l)).join("\n");
  const file = await groq.files.create({
    file: await toFile(Buffer.from(jsonl, "utf-8"), "ebay-batch.jsonl"),
    purpose: "batch",
  });

  const batch = await groq.batches.create({
    input_file_id: file.id,
    endpoint: "/v1/chat/completions",
    completion_window: "24h",
  });

  console.log(`[ebay:batchApi] submitted batch=${batch.id} listings=${listings.length} input_file=${file.id}`);
  return batch.id;
}

export type BatchResultRow = {
  index: number;
  scores: Record<string, number | null> | null;
  overview: string;
  highlights: { label: string; positive: boolean }[];
  error?: string | null;
};

export type BatchStatus = {
  id: string;
  status: string; // validating | in_progress | finalizing | completed | failed | expired | cancelled
  counts: { total: number; completed: number; failed: number };
  results: BatchResultRow[] | null; // populated once completed
  // Ground-truth timing from Groq's own batch object (unix ms), independent of our polling cadence.
  providerMs: number | null;       // created_at → completed_at (full lifecycle incl. queue wait)
  providerProcessingMs: number | null; // in_progress_at → completed_at (actual compute time)
};

function parseScores(raw: string) {
  const extracted = extractStructuredAnalysis(raw);
  const validated = extracted ? validateAnalysis(extracted, EBAY_KEYS) : null;
  return {
    scores: validated?.scores ?? null,
    overview: validated?.overview ?? "",
    highlights: validated?.highlights ?? [],
  };
}

/**
 * Poll a batch. While running, returns status + counts and null results.
 * Once completed, downloads the output file and returns parsed per-listing rows.
 */
export async function getEbayBatchStatus(batchId: string): Promise<BatchStatus> {
  const batch = await groq.batches.retrieve(batchId);
  const counts = {
    total: batch.request_counts?.total ?? 0,
    completed: batch.request_counts?.completed ?? 0,
    failed: batch.request_counts?.failed ?? 0,
  };

  const b = batch as any;
  const providerMs = b.created_at && b.completed_at ? (b.completed_at - b.created_at) * 1000 : null;
  const providerProcessingMs = b.in_progress_at && b.completed_at ? (b.completed_at - b.in_progress_at) * 1000 : null;

  if (batch.status !== "completed" || !batch.output_file_id) {
    return { id: batch.id, status: batch.status, counts, results: null, providerMs, providerProcessingMs };
  }

  const content = await groq.files.content(batch.output_file_id);
  const text = await content.text();

  const rows: BatchResultRow[] = [];
  for (const line of text.split("\n").map((l) => l.trim()).filter(Boolean)) {
    let obj: any;
    try {
      obj = JSON.parse(line);
    } catch {
      continue;
    }
    const index = indexFromCustomId(obj.custom_id ?? "");
    if (obj.error || obj.response?.status_code >= 400) {
      rows.push({ index, scores: null, overview: "", highlights: [], error: obj.error?.message ?? `HTTP ${obj.response?.status_code}` });
      continue;
    }
    const raw = obj.response?.body?.choices?.[0]?.message?.content ?? "{}";
    rows.push({ index, ...parseScores(raw) });
  }

  rows.sort((a, b) => a.index - b.index);
  return { id: batch.id, status: batch.status, counts, results: rows, providerMs, providerProcessingMs };
}

// ─── Drop-in replacement for batchAnalyzeListingsWithImages (live flow) ──────
//
// Returns the SAME contract: one raw JSON string per listing, in input order,
// so analyzeItemsWithAI can parse/cache/score it identically. The difference is
// purely transport: this submits one request PER listing to the async Batch API
// (separate TPM pool, ~50% cost) and blocks until the job completes or times out.
//
// Designed for a gated experiment: the caller wraps this in try/catch and falls
// back to the synchronous path on timeout/failure, so users are never stranded.

export async function batchAnalyzeListingsViaBatchApi(
  listings: any[],
  context?: string | null,
  systemPrompt?: string | null,
  opts?: RawChatBatchOpts,
): Promise<string[]> {
  if (listings.length === 0) return [];

  const messagesList = listings.map((listing) => {
    const messages = buildEbayAnalysisMessages(listing, context);
    // When a group-specific system prompt is supplied (price ranges, condition
    // signals from /context), prepend it to the generic per-listing instructions.
    if (systemPrompt && messages[0]?.role === "system") {
      messages[0].content = `${systemPrompt}\n\n${messages[0].content}`;
    }
    return messages;
  });

  return runRawChatBatch(messagesList, "ebay-live", opts);
}
