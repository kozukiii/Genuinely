import { afterEach, describe, expect, it, vi } from "vitest";

const originalModel = process.env.GROQ_VISION_MODEL;

afterEach(() => {
  vi.resetModules();
  if (originalModel === undefined) delete process.env.GROQ_VISION_MODEL;
  else process.env.GROQ_VISION_MODEL = originalModel;
});

describe("Groq vision model configuration", () => {
  it("uses Maverick when no deployment override is configured", async () => {
    delete process.env.GROQ_VISION_MODEL;

    const models = await import("../groqModels");

    expect(models.GROQ_VISION_MODEL).toBe(
      "meta-llama/llama-4-maverick-17b-128e-instruct",
    );
    expect(models.GROQ_VISION_USAGE_MODEL).toBe("llama-4-maverick-17b");
  });

  it("honors a deployment override", async () => {
    process.env.GROQ_VISION_MODEL = "provider/custom-vision-9b-4e-instruct";

    const models = await import("../groqModels");

    expect(models.GROQ_VISION_MODEL).toBe("provider/custom-vision-9b-4e-instruct");
    expect(models.GROQ_VISION_USAGE_MODEL).toBe("provider/custom-vision-9b");
  });
});
