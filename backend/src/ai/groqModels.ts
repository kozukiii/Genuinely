/**
 * Active Groq model IDs, centralized so provider deprecations can be handled in
 * one place. Deployment overrides make emergency migrations possible without a
 * code release.
 */
export const GROQ_VISION_MODEL =
  process.env.GROQ_VISION_MODEL ?? "qwen/qwen3.8-27b";

export const GROQ_FAST_TEXT_MODEL =
  process.env.GROQ_FAST_TEXT_MODEL ?? "openai/gpt-oss-20b";

export const GROQ_QUALITY_TEXT_MODEL =
  process.env.GROQ_QUALITY_TEXT_MODEL ?? "openai/gpt-oss-120b";

export type GroqServiceTier = "auto" | "default" | "flex";

function serviceTier(value: string | undefined): GroqServiceTier {
  if (value === "on_demand" || value === "default") return "default";
  return value === "flex" ? value : "auto";
}

// `auto` lets paid Groq projects use Flex's larger throughput pool when it is
// available while retaining provider-managed fallback behavior.
export const GROQ_SERVICE_TIER = serviceTier(process.env.GROQ_SERVICE_TIER);

export type GroqVisionSchema =
  | "ebay-single"
  | "ebay-batch"
  | "marketplace-single"
  | "marketplace-batch";

const nullableScore = {
  anyOf: [
    { type: "integer" },
    { type: "null" },
  ],
};
const score = { type: "integer" };
const highlight = {
  type: "object",
  properties: {
    label: { type: "string" },
    positive: { type: "boolean" },
  },
  required: ["label", "positive"],
  additionalProperties: false,
};

function analysisProperties(source: "ebay" | "marketplace") {
  const scoreProperties = source === "ebay"
    ? {
        priceFairness: nullableScore,
        conditionHonesty: score,
        shippingFairness: score,
        descriptionQuality: score,
      }
    : {
        priceFairness: nullableScore,
        sellerTrust: score,
        conditionHonesty: score,
        shippingFairness: score,
        descriptionQuality: score,
      };

  return {
    scores: {
      type: "object",
      properties: scoreProperties,
      required: Object.keys(scoreProperties),
      additionalProperties: false,
    },
    overview: { type: "string" },
    highlights: { type: "array", items: highlight },
  };
}

function responseSchema(kind: GroqVisionSchema) {
  const source = kind.startsWith("ebay") ? "ebay" : "marketplace";
  const properties = analysisProperties(source);
  const analysis = {
    type: "object",
    properties,
    required: ["scores", "overview", "highlights"],
    additionalProperties: false,
  };

  if (kind.endsWith("single")) return analysis;
  const batchItem = {
    ...analysis,
    properties: {
      listingIndex: { type: "integer" },
      ...properties,
    },
    required: ["listingIndex", "scores", "overview", "highlights"],
  };
  return {
    type: "object",
    properties: {
      listings: { type: "array", items: batchItem },
    },
    required: ["listings"],
    additionalProperties: false,
  };
}

/** Qwen 3.8 strict structured output for synchronous vision requests. */
export function buildGroqVisionRequest(
  messages: any[],
  maxTokens: number,
  schema: GroqVisionSchema,
) {
  return {
    model: GROQ_VISION_MODEL,
    service_tier: GROQ_SERVICE_TIER,
    messages,
    max_tokens: maxTokens,
    temperature: 0.2,
    reasoning_effort: "none" as const,
    stream: false as const,
    response_format: {
      type: "json_schema" as const,
      json_schema: {
        name: schema.replace("-", "_"),
        strict: true,
        schema: responseSchema(schema),
      },
    },
  };
}
