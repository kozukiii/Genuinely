// ─── Shared Groq Batch API runner ───────────────────────────────────────────
//
// Submits one chat-completions request per item to Groq's async Batch API
// (separate TPM pool, ~50% cost), blocks until the job completes or times out,
// and returns the raw message-content string for each item IN INPUT ORDER.
// eBay and marketplace live-scoring paths both build their own per-item message
// arrays and hand them here, so the submit/poll/parse logic lives in one place.

import OpenAI, { toFile } from "openai";
import dotenv from "dotenv";

dotenv.config({ quiet: true });

const groq = new OpenAI({
  apiKey: process.env.GROQ_API_KEY!,
  baseURL: "https://api.groq.com/openai/v1",
});

const MODEL = "meta-llama/llama-4-scout-17b-16e-instruct";
const TERMINAL = ["completed", "failed", "expired", "cancelled"];

function sleep(ms: number) { return new Promise<void>((r) => setTimeout(r, ms)); }

export interface RawChatBatchOpts {
  timeoutMs?: number; // give up (and let caller fall back) after this long. Default 90s.
  pollMs?: number;    // status poll interval. Default 1.5s.
  maxTokens?: number; // per-request completion cap. Default 1000.
}

/**
 * Run a batch of independent chat requests. `messagesList[i]` is the full
 * messages array for item i. Returns raw assistant content per item, in order;
 * missing/failed items come back as "{}" so the caller's parser can no-op them.
 * Throws on timeout or a non-complete terminal state so callers can fall back.
 */
export async function runRawChatBatch(
  messagesList: any[][],
  label: string,
  opts?: RawChatBatchOpts,
): Promise<string[]> {
  if (messagesList.length === 0) return [];
  const timeoutMs = opts?.timeoutMs ?? 90_000;
  const pollMs = opts?.pollMs ?? 1500;
  const maxTokens = opts?.maxTokens ?? 1500;

  const jsonl = messagesList
    .map((messages, i) => JSON.stringify({
      custom_id: `item-${i}`,
      method: "POST",
      url: "/v1/chat/completions",
      body: { model: MODEL, messages, max_tokens: maxTokens, temperature: 0.2, response_format: { type: "json_object" } },
    }))
    .join("\n");

  const file = await groq.files.create({
    file: await toFile(Buffer.from(jsonl, "utf-8"), `${label}.jsonl`),
    purpose: "batch",
  });
  const batch = await groq.batches.create({
    input_file_id: file.id,
    endpoint: "/v1/chat/completions",
    completion_window: "24h",
  });
  console.log(`[groqBatch:${label}] submitted batch=${batch.id} items=${messagesList.length}`);

  const start = Date.now();
  const deadline = start + timeoutMs;
  let current: any = batch;
  while (!TERMINAL.includes(current.status)) {
    if (Date.now() > deadline) {
      throw new Error(`batch ${batch.id} timed out after ${timeoutMs}ms (status=${current.status})`);
    }
    await sleep(pollMs);
    current = await groq.batches.retrieve(batch.id);
  }
  if (current.status !== "completed" || !current.output_file_id) {
    throw new Error(`batch ${batch.id} ended non-complete (status=${current.status})`);
  }

  const content = await groq.files.content(current.output_file_id);
  const text = await content.text();

  const rawByIndex = new Map<number, string>();
  for (const line of text.split("\n").map((l) => l.trim()).filter(Boolean)) {
    let obj: any;
    try { obj = JSON.parse(line); } catch { continue; }
    const m = String(obj.custom_id ?? "").match(/^item-(\d+)$/);
    if (!m) continue;
    const raw = obj.response?.body?.choices?.[0]?.message?.content;
    rawByIndex.set(Number(m[1]), typeof raw === "string" ? raw : "{}");
  }

  console.log(`[groqBatch:${label}] batch=${batch.id} completed in ~${Date.now() - start}ms, ${rawByIndex.size}/${messagesList.length} parsed`);
  return messagesList.map((_, i) => rawByIndex.get(i) ?? "{}");
}
