import { afterEach, describe, expect, it, vi } from "vitest";

const originalEnv = { ...process.env };

afterEach(() => {
  process.env = { ...originalEnv };
  vi.resetModules();
});

describe("Groq model configuration", () => {
  it("defaults to active Groq model IDs", async () => {
    delete process.env.GROQ_VISION_MODEL;
    delete process.env.GROQ_FAST_TEXT_MODEL;
    delete process.env.GROQ_QUALITY_TEXT_MODEL;

    const models = await import("../groqModels");

    expect(models.GROQ_VISION_MODEL).toBe("qwen/qwen3.8-27b");
    expect(models.GROQ_FAST_TEXT_MODEL).toBe("openai/gpt-oss-20b");
    expect(models.GROQ_QUALITY_TEXT_MODEL).toBe("openai/gpt-oss-120b");
  });

  it("honors deployment overrides", async () => {
    process.env.GROQ_VISION_MODEL = "provider/vision";
    process.env.GROQ_FAST_TEXT_MODEL = "provider/fast";
    process.env.GROQ_QUALITY_TEXT_MODEL = "provider/quality";

    const models = await import("../groqModels");

    expect(models.GROQ_VISION_MODEL).toBe("provider/vision");
    expect(models.GROQ_FAST_TEXT_MODEL).toBe("provider/fast");
    expect(models.GROQ_QUALITY_TEXT_MODEL).toBe("provider/quality");
  });

  it("uses strict JSON Schema output for vision requests", async () => {
    const { buildGroqVisionRequest } = await import("../groqModels");
    const request = buildGroqVisionRequest(
      [{ role: "user", content: "Return JSON" }],
      1000,
      "ebay-single",
    );

    expect(request.response_format.type).toBe("json_schema");
    expect(request.response_format.json_schema.strict).toBe(true);
    expect(request.response_format.json_schema.schema.required).toEqual([
      "scores",
      "overview",
      "highlights",
    ]);
  });

  it("uses source-specific schemas for packed results", async () => {
    const { buildGroqVisionRequest } = await import("../groqModels");
    const request = buildGroqVisionRequest([], 5000, "marketplace-batch");
    const schema: any = request.response_format.json_schema.schema;
    const item = schema.properties.listings.items;

    expect(item.required).toContain("listingIndex");
    expect(item.properties.scores.required).toContain("sellerTrust");
    expect(item.properties.scores.additionalProperties).toBe(false);
    expect(item.additionalProperties).toBe(false);
  });
});
