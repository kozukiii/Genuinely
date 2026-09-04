import OpenAI from "openai";
import dotenv from "dotenv";
import { buildGroqVisionRequest, type GroqVisionSchema } from "./groqModels";

dotenv.config({ quiet: true });

let groq: OpenAI | null = null;

function groqClient() {
  if (!groq) {
    groq = new OpenAI({
      apiKey: process.env.GROQ_API_KEY!,
      baseURL: "https://api.groq.com/openai/v1",
      maxRetries: 0,
      timeout: 30_000,
    });
  }
  return groq;
}

export interface RawChatRequestOpts {
  maxTokens?: number;
  schema?: GroqVisionSchema;
  schemas?: GroqVisionSchema[];
  concurrency?: number;
  /** Leave failed slots empty so callers can retain successful listing scores. */
  allowPartial?: boolean;
}

const RETRYABLE_STATUSES = new Set([408, 409, 429, 498, 500, 502, 503, 504]);
const MAX_ATTEMPTS = 8;
const DEFAULT_MAX_TOKENS = 700;
let rateLimitBlockedUntil = 0;

function sleep(ms: number) {
  return new Promise<void>((resolve) => setTimeout(resolve, ms));
}

function headerValue(error: any, name: string): string | undefined {
  const headers = error?.headers;
  const value = typeof headers?.get === "function"
    ? headers.get(name)
    : headers?.[name] ?? headers?.[name.toLowerCase()];
  return value == null ? undefined : String(value);
}

/** Parse Groq's retry window without exposing response headers in logs. */
export function groqRetryDelayMs(error: any, attempt: number): number {
  const retryAfter = Number.parseFloat(headerValue(error, "retry-after") ?? "");
  if (Number.isFinite(retryAfter) && retryAfter >= 0) {
    return Math.ceil(retryAfter * 1000) + 250;
  }

  const messageSeconds = String(error?.message ?? "").match(/try again in\s+([\d.]+)s/i);
  if (messageSeconds) return Math.ceil(Number(messageSeconds[1]) * 1000) + 250;

  return Math.min(8_000, 500 * (2 ** Math.max(0, attempt - 1)));
}

async function waitForSharedRateLimit() {
  const remaining = rateLimitBlockedUntil - Date.now();
  if (remaining > 0) await sleep(remaining);
}

function schemasForRequests(
  messagesList: any[][],
  label: string,
  opts?: RawChatRequestOpts,
): GroqVisionSchema[] {
  if (opts?.schemas?.length === messagesList.length) return opts.schemas;
  if (opts?.schema) return messagesList.map(() => opts.schema!);
  throw new Error(`Groq request group ${label} requires one response schema per request`);
}

/**
 * Run vision chat completions with bounded concurrency. Groq's Batch API does
 * not support Qwen vision models, so every scoring request uses synchronous
 * Chat Completions and strict structured output.
 */
export async function runRawChatRequests(
  messagesList: any[][],
  label: string,
  opts?: RawChatRequestOpts,
): Promise<string[]> {
  if (messagesList.length === 0) return [];
  const schemas = schemasForRequests(messagesList, label, opts);
  const maxTokens = opts?.maxTokens ?? DEFAULT_MAX_TOKENS;
  const concurrency = Math.max(1, Math.min(opts?.concurrency ?? 4, messagesList.length));
  const results = new Array<string>(messagesList.length).fill("");
  let nextIndex = 0;
  const start = Date.now();

  async function worker() {
    while (true) {
      const index = nextIndex++;
      if (index >= messagesList.length) return;
      for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
        try {
          await waitForSharedRateLimit();
          const response = await groqClient().chat.completions.create(
            buildGroqVisionRequest(messagesList[index], maxTokens, schemas[index]),
          );
          const content = response.choices[0]?.message?.content?.trim();
          if (response.choices[0]?.finish_reason === "length") {
            throw Object.assign(new Error("Groq completion was truncated"), { status: 422 });
          }
          if (!content) throw new Error(`Groq ${label} request ${index} returned empty content`);
          results[index] = content;
          break;
        } catch (error: any) {
          const retryable = error?.status == null || RETRYABLE_STATUSES.has(error.status);
          if (!retryable || attempt === MAX_ATTEMPTS) {
            if (!opts?.allowPartial) throw error;
            console.warn(`[groqChat:${label}] request ${index} failed (status=${error?.status ?? "network"}); preserving other results`);
            break;
          }

          // Flex capacity errors are intentionally transient. Jitter prevents
          // concurrent listing workers from retrying in lockstep.
          const delayMs = groqRetryDelayMs(error, attempt)
            + (error?.status === 498 ? Math.floor(Math.random() * 750) : 0);
          if (error?.status === 429) {
            rateLimitBlockedUntil = Math.max(rateLimitBlockedUntil, Date.now() + delayMs);
          }
          await sleep(delayMs);
        }
      }
    }
  }

  await Promise.all(Array.from({ length: concurrency }, () => worker()));
  console.log(`[groqChat:${label}] completed ${results.length} requests in ${Date.now() - start}ms (concurrency=${concurrency})`);
  return results;
}
