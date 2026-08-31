/**
 * Active Groq model IDs, centralized so provider deprecations can be handled in
 * one place. Deployment overrides make emergency migrations possible without a
 * code release.
 */
export const GROQ_VISION_MODEL =
  process.env.GROQ_VISION_MODEL ?? "qwen/qwen3.6-27b";

export const GROQ_FAST_TEXT_MODEL =
  process.env.GROQ_FAST_TEXT_MODEL ?? "openai/gpt-oss-20b";

export const GROQ_QUALITY_TEXT_MODEL =
  process.env.GROQ_QUALITY_TEXT_MODEL ?? "openai/gpt-oss-120b";
