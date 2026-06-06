# Infrastructure Notes — Batch API Investigation
_Generated 2026-06-06_

---

## Recent Changes (last 5 commits)

| Commit | Summary |
|--------|---------|
| `cd7b722` | Reverted to SSE approach but batching each group request |
| `92fa577` | Hardcoded TCG card prompt to reduce latency for TCG searches |
| `0214b86` | Score entire search in one combined batch job instead of per-group |
| `d6dd55c` | Stop dropping photos past 5 — pack overflow into stitched grids |
| `c13c06e` | Routed live eBay + marketplace analysis through Groq Batch API |

### Key files added/changed
- `backend/src/ai/groqBatchRun.ts` — shared Groq Batch API runner (submit/poll/parse)
- `backend/src/ai/ebayBatchApi.ts` — eBay-specific batch implementation
- `backend/src/ai/marketplaceBatchApi.ts` — Marketplace batch (base64 images, 120s timeout)
- `backend/src/services/scoring/scoreGroupsBatch.ts` — scores all groups in ONE batch job
- `backend/src/routes/searchRoutes.ts` — added `/batch-analyze-all`, `/context` SSE, `/batch-analyze`
- `frontend/src/pages/EbayBatchTestPage.tsx` — admin batch test page

---

## Current Architecture

```
/context (SSE)
  └── Serper resolves groups → streams contextToken per group as ready

/batch-analyze (per group)
  └── consumes contextToken → runs Groq batch job per group

/batch-analyze-all (all groups)
  └── collects all contextTokens → ONE Groq batch job for everything
```

**Current default:** SSE hybrid — streams groups from Serper, fires a separate Groq batch job per group as each context token arrives.

---

## Why Batch Was Slower Than Sync (the mystery)

Groq's Batch API is **asynchronous with no latency guarantee**. Every job pays a fixed overhead:

1. File upload (network round trip)
2. Batch create (round trip)
3. Queue time (variable, not guaranteed immediate)
4. Poll loop — minimum 1.5s dead time per cycle (`pollMs = 1500` in `groqBatchRun.ts`)
5. Output file download (round trip)

For a single user not under heavy TPM pressure, sync requests complete in 2-4s each. Batch adds 3-5s of fixed overhead regardless of job size. Result:

- **Sync path:** ~13-17s eBay, ~30s Marketplace
- **Batch path:** ~30s+ across the board

Even with a 1s TPM cooldown on one sync request, sync is still faster because it's a one-time hit vs guaranteed overhead on every batch lifecycle.

**The batch API only wins when TPM is genuinely saturated** — multiple concurrent users pushing you into repeated rate limit cooldowns.

---

## Key Findings

### Batch API tradeoffs
| | Sync | Batch |
|---|---|---|
| Single user latency | Fast (13-17s eBay) | Slow (+3-5s overhead) |
| TPM pool | Standard (limited) | Separate higher-capacity pool |
| Token cost | Standard | ~50% cheaper |
| Latency guarantee | Immediate | None (queue-based) |

### Token cost savings
Groq pricing is cheap enough that 50% token savings is negligible at current scale. Not a meaningful reason to use batch.

### N batch jobs vs 1 batch job
Running separate batch jobs per group (SSE hybrid) means N polling loops running concurrently — each adds overhead and jitter. `scoreGroupsInOneBatch` collapses this to one polling loop but requires waiting for all Serper context first. For single users, both are slower than sync anyway.

---

## Recommended Path Forward

### Short term (highest ROI)
1. **Groq business account** — higher sync TPM limit. Immediately improves single-user latency and concurrent user capacity without any architectural change.
2. **Serper paid plan** — reduces context fetch time, which is real latency on every search.

### Medium term
3. **Load-based routing** — server-side counter tracking in-flight Groq requests. Below threshold → sync (fast). Above threshold → batch (protected). Backend is on Render (persistent Node process) so shared memory counter works fine.

```typescript
let activeGroqRequests = 0;
const BATCH_THRESHOLD = 2;

export function trackGroqRequest<T>(fn: () => Promise<T>): Promise<T> {
  activeGroqRequests++;
  return fn().finally(() => activeGroqRequests--);
}

export function isUnderLoad(): boolean {
  return activeGroqRequests >= BATCH_THRESHOLD;
}
```

### Long term
4. **Request queue with batching window** — hold requests for 1-2s, submit together in one batch job. Scales to N concurrent users with zero additional credentials. Small fixed latency penalty, large throughput gain.

---

## Open Investigation

### Groq web search models in batch
Groq supports web search capable models. If these work on the standard `/v1/chat/completions` endpoint (which `groqBatchRun.ts` uses), they could theoretically run in batch — eliminating Serper and the entire `/context` pipeline.

**Worth benchmarking:** sync web search LLM end-to-end vs current sync Serper + Groq baseline.
- Already measured: Groq web search ~20% slower than Serper in isolation
- But: eliminates Serper round trip + context pipeline entirely
- Batch path still has polling overhead — likely still slower than sync for single users
- Real question: does sync web search LLM beat sync Serper + sync Groq total?

**Test when back in IDE:** swap model ID in `groqBatchRun.ts` to web search model, run against current baseline with realistic load.

---

## Current Latency Baseline
- eBay: 13-17s (Serper + Groq inference, hitting TPM limits occasionally)
- Marketplace: ~30s (proxy racing is the ceiling — no real API available)
