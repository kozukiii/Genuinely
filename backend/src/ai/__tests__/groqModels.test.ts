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

    expect(models.GROQ_VISION_MODEL).toBe("qwen/qwen3.6-27b");
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
});
