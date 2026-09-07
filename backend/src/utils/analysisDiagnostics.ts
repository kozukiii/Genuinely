import { AsyncLocalStorage } from "node:async_hooks";
import { createHash } from "node:crypto";

export const analysisTrace = new AsyncLocalStorage<{ run: string; source: string; listing: string }>();

// Never log credentials, complete URLs, prompts, model output, or image bytes.
export function imageIdentity(url: string) {
  let host = "invalid";
  try { host = new URL(url).hostname; } catch { /* report invalid URLs safely */ }
  return { host, image: createHash("sha256").update(url).digest("hex").slice(0, 12) };
}

export function failureKind(error: any): string {
  const message = String(error?.message ?? "");
  if (/schema|json_validate_failed/i.test(message)) return "schema_generation";
  if (/truncated/i.test(message)) return "truncated_completion";
  if (/Failed to fetch.*images/i.test(message)) return "missing_images";
  if (/vision capacity|image count/i.test(message)) return "image_capacity";
  if (error?.name === "AbortError" || error?.name === "TimeoutError") return "timeout";
  const code = error?.cause?.code ?? error?.code;
  return typeof code === "string" && /^[A-Z_0-9]{1,40}$/.test(code) ? code : "other";
}

export function diagnostic(stage: string, fields: Record<string, unknown>) {
  console.log(`[analysis-diag] ${JSON.stringify({ stage, ...analysisTrace.getStore(), ...fields })}`);
}
