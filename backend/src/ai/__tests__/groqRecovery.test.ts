import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { create } = vi.hoisted(() => ({ create: vi.fn() }));
vi.mock("openai", () => ({ default: class {
  chat = { completions: { create } };
} }));
import { runRawChatRequests } from "../groqBatchRun";

const success = { choices: [{ finish_reason: "stop", message: { content: '{"scores":{},"overview":"ok","highlights":[]}' } }] };
beforeEach(() => { create.mockReset(); vi.useFakeTimers(); });
afterEach(() => { vi.useRealTimers(); });

describe("production scoring recovery", () => {
  it("isolates the observed schema-generation 400 without retrying", async () => {
    create.mockRejectedValueOnce({ status: 400, message: "Generated JSON does not match the expected schema" }).mockResolvedValue(success);
    const result = runRawChatRequests([[]], "test", { schema: "ebay-single", allowPartial: true });
    await vi.runAllTimersAsync();
    expect(await result).toEqual([""]);
    expect(create).toHaveBeenCalledTimes(1);
  });
  it("preserves successful slots when another request permanently fails", async () => {
    create.mockRejectedValueOnce({ status: 400, message: "Invalid model" }).mockResolvedValue(success);
    const result = await runRawChatRequests([[], []], "test", { schema: "ebay-single", allowPartial: true, concurrency: 1 });
    expect(result[0]).toBe("");
    expect(result[1]).toContain('"overview":"ok"');
    expect(create).toHaveBeenCalledTimes(2);
  });
  it("keeps fail-fast behavior for callers that do not opt into partial results", async () => {
    create.mockRejectedValue({ status: 401 });
    await expect(runRawChatRequests([[]], "test", { schema: "ebay-single" })).rejects.toEqual({ status: 401 });
  });
  it("does not accept truncated content as a successful score", async () => {
    create.mockResolvedValueOnce({ choices: [{ finish_reason: "length", message: { content: "{" } }] }).mockResolvedValue(success);
    const result = runRawChatRequests([[]], "test", { schema: "ebay-single", allowPartial: true });
    await vi.runAllTimersAsync();
    expect(await result).toEqual([""]);
    expect(create).toHaveBeenCalledTimes(1);
  });
});
