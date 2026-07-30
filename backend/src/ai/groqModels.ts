import dotenv from "dotenv";

dotenv.config({ quiet: true });

/**
 * Groq's Llama 4 Scout model was retired.  Keep the vision-capable replacement
 * in one place so the synchronous and Batch API paths cannot silently drift.
 *
 * Deployments can override this without a code change when Groq changes its
 * model catalogue again.
 */
export const GROQ_VISION_MODEL =
  process.env.GROQ_VISION_MODEL ?? "meta-llama/llama-4-maverick-17b-128e-instruct";

/** Normalized label used by the internal token-usage report. */
export const GROQ_VISION_USAGE_MODEL = GROQ_VISION_MODEL
  .replace(/^meta-llama\//, "")
  .replace(/-\d+e-instruct$/, "");
