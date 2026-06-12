import { useEffect, useRef, useState } from "react";
import type { FormEvent } from "react";
import { Link } from "react-router-dom";
import { useAuth } from "../context/AuthContext";
import "./styles/AdminPage.css";

const API_BASE = import.meta.env.VITE_API_BASE_URL ?? "";

const EBAY_KEYS = ["priceFairness", "conditionHonesty", "shippingFairness", "descriptionQuality"];
const POLL_MS = 1000;
type Scheme = "serper" | "groq";

interface SubmitListing {
  title: string | null;
  url: string | null;
  price: number | null;
  currency: string;
  condition: string | null;
  image: string | null;
}

interface ResultRow {
  index: number;
  scores: Record<string, number | null> | null;
  overview: string;
  highlights: { label: string; positive: boolean }[];
  error?: string | null;
}

interface StatusResponse {
  id: string;
  status: string;
  counts: { total: number; completed: number; failed: number };
  results: ResultRow[] | null;
  elapsedMs: number | null;
  providerMs: number | null;
  providerProcessingMs: number | null;
}

interface ContextResponse {
  scheme: Scheme;
  context: string | null;
  elapsedMs: number;
  tokens: number | null;
}

interface LaneState {
  context: ContextResponse | null;
  status: StatusResponse | null;
  contextPaintedMs: number | null;
  batchSubmittedMs: number | null;
  error: string | null;
}

const emptyLane = (): LaneState => ({
  context: null,
  status: null,
  contextPaintedMs: null,
  batchSubmittedMs: null,
  error: null,
});

function fmtMs(ms: number | null): string {
  if (ms == null) return "-";
  if (ms < 1000) return `${Math.round(ms)} ms`;
  return `${(ms / 1000).toFixed(1)} s`;
}

function schemeLabel(scheme: Scheme) {
  return scheme === "serper" ? "Serper context" : "Groq web context";
}

function ScoreCell({ r }: { r: ResultRow | undefined }) {
  if (!r) return <p className="admin-card-note">awaiting...</p>;
  if (r.error) return <p className="admin-error">Error: {r.error}</p>;
  return (
    <>
      {r.scores && (
        <div style={{ display: "flex", gap: 8, flexWrap: "wrap", marginBottom: 6 }}>
          {EBAY_KEYS.map((k) => (
            <span key={k} className="admin-card-note" style={{ fontVariantNumeric: "tabular-nums" }}>
              {k.replace("Fairness", "").replace("Honesty", "").replace("Quality", "")}:{" "}
              <strong>{r.scores?.[k] ?? "-"}</strong>
            </span>
          ))}
        </div>
      )}
      {r.overview && <p className="admin-card-note" style={{ margin: "2px 0" }}>{r.overview}</p>}
      {r.highlights?.length > 0 && (
        <ul style={{ margin: "6px 0 0", paddingLeft: 16 }}>
          {r.highlights.map((h, hi) => (
            <li key={hi} className="admin-card-note" style={{ color: h.positive ? "#1aad54" : "#d9534f" }}>
              {h.positive ? "yes" : "no"} {h.label}
            </li>
          ))}
        </ul>
      )}
    </>
  );
}

export default function EbayBatchTestPage() {
  const { user, loading } = useAuth();
  const [query, setQuery] = useState("");
  const [limit, setLimit] = useState(8);
  const [running, setRunning] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [listings, setListings] = useState<SubmitListing[]>([]);
  const [lanes, setLanes] = useState<Record<Scheme, LaneState>>({ serper: emptyLane(), groq: emptyLane() });

  const t0Ref = useRef<number>(0);
  const [nowMs, setNowMs] = useState(0);
  const pollRefs = useRef<Partial<Record<Scheme, ReturnType<typeof setInterval>>>>({});
  const tickRef = useRef<ReturnType<typeof setInterval> | null>(null);

  function stopTimers() {
    for (const timer of Object.values(pollRefs.current)) {
      if (timer) clearInterval(timer);
    }
    pollRefs.current = {};
    if (tickRef.current) clearInterval(tickRef.current);
    tickRef.current = null;
  }

  useEffect(() => stopTimers, []);

  function updateLane(scheme: Scheme, patch: Partial<LaneState>) {
    setLanes((prev) => ({ ...prev, [scheme]: { ...prev[scheme], ...patch } }));
  }

  async function poll(scheme: Scheme, id: string) {
    try {
      const res = await fetch(`${API_BASE}/api/internal/ebay-batch-test/status?id=${encodeURIComponent(id)}`, {
        credentials: "include",
      });
      const json: StatusResponse = await res.json();
      if (!res.ok) throw new Error((json as any).error ?? `${res.status}`);
      updateLane(scheme, { status: json });
      const terminal = ["completed", "failed", "expired", "cancelled"].includes(json.status);
      if (terminal) {
        const timer = pollRefs.current[scheme];
        if (timer) clearInterval(timer);
        delete pollRefs.current[scheme];
      }
    } catch (e: any) {
      updateLane(scheme, { error: e.message });
      const timer = pollRefs.current[scheme];
      if (timer) clearInterval(timer);
      delete pollRefs.current[scheme];
    }
  }

  async function runLane(scheme: Scheme, runId: string) {
    try {
      const contextRes = await fetch(`${API_BASE}/api/internal/ebay-batch-test/context/${scheme}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify({ runId }),
      });
      const contextJson = await contextRes.json();
      if (!contextRes.ok) throw new Error(contextJson.error ?? `${scheme} context ${contextRes.status}`);
      updateLane(scheme, { context: contextJson, contextPaintedMs: Date.now() - t0Ref.current });

      const submitRes = await fetch(`${API_BASE}/api/internal/ebay-batch-test/batch-submit`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify({ runId, scheme }),
      });
      const submitJson = await submitRes.json();
      if (!submitRes.ok) throw new Error(submitJson.error ?? `${scheme} batch ${submitRes.status}`);
      updateLane(scheme, { batchSubmittedMs: Date.now() - t0Ref.current });

      await poll(scheme, submitJson.batchId);
      pollRefs.current[scheme] = setInterval(() => poll(scheme, submitJson.batchId), POLL_MS);
    } catch (e: any) {
      updateLane(scheme, { error: e.message });
    }
  }

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!query.trim()) return;

    stopTimers();
    setRunning(true);
    setError(null);
    setListings([]);
    setLanes({ serper: emptyLane(), groq: emptyLane() });
    setNowMs(0);

    try {
      const searchRes = await fetch(`${API_BASE}/api/internal/ebay-batch-test/search`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify({ query: query.trim(), limit }),
      });
      const searchJson = await searchRes.json();
      if (!searchRes.ok) throw new Error(searchJson.error ?? `${searchRes.status}`);
      setListings(searchJson.listings ?? []);
      const runId: string = searchJson.runId;

      t0Ref.current = Date.now();
      tickRef.current = setInterval(() => setNowMs(Date.now() - t0Ref.current), 100);
      await Promise.allSettled([runLane("serper", runId), runLane("groq", runId)]);
    } catch (e: any) {
      setError(e.message);
    } finally {
      setRunning(false);
    }
  }

  useEffect(() => {
    const done = (["serper", "groq"] as Scheme[]).every((scheme) => lanes[scheme].batchSubmittedMs || lanes[scheme].error);
    if (done && tickRef.current) {
      clearInterval(tickRef.current);
      tickRef.current = null;
    }
  }, [lanes]);

  if (loading) return null;
  if (!user?.isAdmin) {
    return (
      <main className="admin-page">
        <p className="admin-forbidden">403 - Forbidden</p>
      </main>
    );
  }

  const byScheme = (scheme: Scheme) => {
    const map = new Map<number, ResultRow>();
    lanes[scheme].status?.results?.forEach((r) => map.set(r.index, r));
    return map;
  };
  const serperByIndex = byScheme("serper");
  const groqByIndex = byScheme("groq");

  return (
    <main className="admin-page">
      <Link to="/admin" className="admin-card-note" style={{ textDecoration: "underline" }}>Back to Admin</Link>
      <h1 className="admin-heading">eBay Context + Batch Analysis Test</h1>
      <p className="admin-card-note" style={{ maxWidth: 760, marginBottom: 16 }}>
        Search runs once and is not timed. Then Serper context and Groq web context run side by side.
        Each lane submits the same eBay listings to the same Groq Batch analysis path after its context lands.
      </p>

      <form onSubmit={handleSubmit} style={{ display: "flex", gap: 8, flexWrap: "wrap", marginBottom: 24 }}>
        <input
          type="text"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="e.g. ping sigma 3 putter"
          style={{ flex: "1 1 320px", padding: "10px 12px", fontSize: 15 }}
        />
        <input
          type="number"
          min={1}
          max={20}
          value={limit}
          onChange={(e) => setLimit(Number(e.target.value))}
          style={{ width: 80, padding: "10px 12px", fontSize: 15 }}
          title="Number of listings"
        />
        <button type="submit" disabled={running} style={{ padding: "10px 20px", fontSize: 15 }}>
          {running ? "Running..." : "Search & Compare"}
        </button>
      </form>

      {error && <p className="admin-error">Error: {error}</p>}

      {listings.length > 0 && (
        <>
          <section className="admin-section">
            <div className="admin-cards" style={{ gridTemplateColumns: "repeat(2, 1fr)" }}>
              {(["serper", "groq"] as Scheme[]).map((scheme) => {
                const lane = lanes[scheme];
                const terminal = lane.status && ["completed", "failed", "expired", "cancelled"].includes(lane.status.status);
                return (
                  <div key={scheme} className="admin-card">
                    <span className="admin-card-name">{schemeLabel(scheme)}</span>
                    <p className="admin-heading" style={{ margin: "6px 0", fontVariantNumeric: "tabular-nums" }}>
                      {fmtMs(lane.batchSubmittedMs ?? (lane.error ? null : nowMs))}
                    </p>
                    <span className="admin-card-note">
                      context: <strong>{fmtMs(lane.contextPaintedMs)}</strong>
                      {lane.context?.tokens != null ? ` · ${lane.context.tokens} tokens` : ""}
                    </span>
                    <span className="admin-card-note" style={{ marginTop: 4 }}>
                      batch: {lane.batchSubmittedMs != null ? "submitted to Groq Batch" : lane.status ? `${lane.status.status} · ${lane.status.counts.completed}/${lane.status.counts.total}` : lane.context ? "submitting..." : "waiting for context..."}
                    </span>
                    {terminal && lane.status?.providerMs != null && (
                      <span className="admin-card-note" style={{ marginTop: 4 }}>
                        Groq batch measured: <strong>{fmtMs(lane.status.providerMs)}</strong>
                        {lane.status.providerProcessingMs != null ? ` · ${fmtMs(lane.status.providerProcessingMs)} compute` : ""}
                      </span>
                    )}
                    {lane.error && <p className="admin-error">{lane.error}</p>}
                    {lane.context?.context && (
                      <details style={{ marginTop: 8 }}>
                        <summary className="admin-card-note">context preview</summary>
                        <pre className="admin-card-note" style={{ whiteSpace: "pre-wrap", maxHeight: 180, overflow: "auto" }}>{lane.context.context}</pre>
                      </details>
                    )}
                  </div>
                );
              })}
            </div>
          </section>

          <section className="admin-section">
            {listings.map((l, i) => (
              <div key={i} className="admin-card" style={{ alignItems: "stretch", textAlign: "left", marginBottom: 16 }}>
                <div style={{ display: "flex", gap: 12, marginBottom: 12 }}>
                  {l.image && (
                    <img src={l.image} alt="" width={64} height={64} style={{ objectFit: "cover", borderRadius: 8, flexShrink: 0 }} />
                  )}
                  <div style={{ minWidth: 0 }}>
                    <a href={l.url ?? "#"} target="_blank" rel="noreferrer" className="admin-card-name" style={{ display: "block", whiteSpace: "normal" }}>
                      {l.title ?? "Untitled"}
                    </a>
                    <p className="admin-card-note" style={{ margin: "4px 0 0" }}>
                      {l.price != null ? `${l.price} ${l.currency}` : "-"} · {l.condition ?? "-"}
                    </p>
                  </div>
                </div>

                <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 16 }}>
                  <div style={{ borderRight: "1px solid #2a2a2a", paddingRight: 16 }}>
                    <p className="admin-card-note" style={{ fontWeight: 600, marginBottom: 4 }}>Serper context + batch</p>
                    <ScoreCell r={serperByIndex.get(i)} />
                  </div>
                  <div>
                    <p className="admin-card-note" style={{ fontWeight: 600, marginBottom: 4 }}>Groq web context + batch</p>
                    <ScoreCell r={groqByIndex.get(i)} />
                  </div>
                </div>
              </div>
            ))}
          </section>
        </>
      )}
    </main>
  );
}
