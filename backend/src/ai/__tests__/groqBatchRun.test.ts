import { describe, expect, it } from "vitest";
import { groqRetryDelayMs } from "../groqBatchRun";

describe("Groq retry timing", () => {
  it("honors numeric retry-after headers", () => {
    expect(groqRetryDelayMs({ headers: { "retry-after": "2.5" } }, 1)).toBe(2750);
  });

  it("falls back to the retry window embedded in Groq's error message", () => {
    expect(groqRetryDelayMs({ message: "Please try again in 48.8625s." }, 1)).toBe(49113);
  });

  it("uses bounded exponential backoff when no provider window is present", () => {
    expect(groqRetryDelayMs({}, 1)).toBe(500);
    expect(groqRetryDelayMs({}, 8)).toBe(8000);
  });
});
