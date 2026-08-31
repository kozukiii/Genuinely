import OpenAI from "openai";
import dotenv from "dotenv";
import { buildGroqVisionRequest, type GroqVisionSchema } from "./groqModels";

dotenv.config({ quiet: true });

const groq = new OpenAI({
  apiKey: process.env.GROQ_API_KEY!,
  baseURL: "https://api.groq.com/openai/v1",
});

export interface RawChatRequestOpts {
  maxTokens?: number;
  schema?: GroqVisionSchema;
  schemas?: GroqVisionSchema[];
  concurrency?: number;
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
  const maxTokens = opts?.maxTokens ?? 1500;
  const concurrency = Math.max(1, Math.min(opts?.concurrency ?? 4, messagesList.length));
  const results = new Array<string>(messagesList.length);
  let nextIndex = 0;
  const start = Date.now();

  async function worker() {
    while (true) {
      const index = nextIndex++;
      if (index >= messagesList.length) return;
      const response = await groq.chat.completions.create(
        buildGroqVisionRequest(messagesList[index], maxTokens, schemas[index]),
      );
      const content = response.choices[0]?.message?.content?.trim();
      if (!content) throw new Error(`Groq ${label} request ${index} returned empty content`);
      results[index] = content;
    }
  }

  await Promise.all(Array.from({ length: concurrency }, () => worker()));
  console.log(`[groqChat:${label}] completed ${results.length} requests in ${Date.now() - start}ms (concurrency=${concurrency})`);
  return results;
}
