import { useEffect, useRef, useState } from "react";
import type { FormEvent } from "react";
import { Link } from "react-router-dom";
import { useAuth } from "../context/AuthContext";
import "./styles/AdminPage.css";

const API_BASE = import.meta.env.VITE_API_BASE_URL ?? "";

const EBAY_KEYS = ["priceFairness", "conditionHonesty", "shippingFairness", "descriptionQuality"];
const POLL_MS = 1000;

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

function fmtMs(ms: number | null): string {
  if (ms == null) return "—";
  if (ms < 1000) return `${Math.round(ms)} ms`;
  return `${(ms / 1000).toFixed(1)} s`;
}

function ScoreCell({ r }: { r: ResultRow | undefined }) {
  if (!r) return <p className="admin-card-note">⏳ awaiting…</p>;
  if (r.error) return <p className="admin-error">⚠ {r.error}</p>;
  return (
    <>
      {r.scores && (
        <div style={{ display: "flex", gap: 8, flexWrap: "wrap", marginBottom: 6 }}>
          {EBAY_KEYS.map((k) => (
            <span key={k} className="admin-card-note" style={{ fontVariantNumeric: "tabular-nums" }}>
              {k.replace("Fairness", "").replace("Honesty", "").replace("Quality", "")}:{" "}
              <strong>{r.scores?.[k] ?? "—"}</strong>
            </span>
          ))}
        </div>
      )}
      {r.overview && <p className="admin-card-note" style={{ margin: "2px 0" }}>{r.overview}</p>}
      {r.highlights?.length > 0 && (
        <ul style={{ margin: "6px 0 0", paddingLeft: 16 }}>
          {r.highlights.map((h, hi) => (
            <li key={hi} className="admin-card-note" style={{ color: h.positive ? "#1aad54" : "#d9534f" }}>
              {h.positive ? "✓" : "✕"} {h.label}
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
  const [syncResults, setSyncResults] = useState<ResultRow[] | null>(null);
  const [status, setStatus] = useState<StatusResponse | null>(null);

  // All timers measured from a single shared t0 (button click), in the browser.
  const t0Ref = useRef<number>(0);
  const [nowMs, setNowMs] = useState(0);                 // live ticker for in-flight columns
  const [syncPaintedMs, setSyncPaintedMs] = useState<number | null>(null);
  const [batchPaintedMs, setBatchPaintedMs] = useState<number | null>(null);

  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const tickRef = useRef<ReturnType<typeof setInterval> | null>(null);

  function stopTimers() {
    if (pollRef.current) clearInterval(pollRef.current);
    if (tickRef.current) clearInterval(tickRef.current);
    pollRef.current = null;
    tickRef.current = null;
  }
  useEffect(() => stopTimers, []);

  function maybeStopTicker(syncDone: boolean, batchDone: boolean) {
    if (syncDone && batchDone && tickRef.current) {
      clearInterval(tickRef.current);
      tickRef.current = null;
    }
  }

  async function poll(id: string) {
    try {
      const res = await fetch(`${API_BASE}/api/internal/ebay-batch-test/status?id=${encodeURIComponent(id)}`, {
        credentials: "include",
      });
      const json: StatusResponse = await res.json();
      if (!res.ok) throw new Error((json as any).error ?? `${res.status}`);
      setStatus(json);
      const terminal = ["completed", "failed", "expired", "cancelled"].includes(json.status);
      if (terminal) {
        // First terminal observation = when the batch column actually paints.
        setBatchPaintedMs((prev) => prev ?? Date.now() - t0Ref.current);
        if (pollRef.current) { clearInterval(pollRef.current); pollRef.current = null; }
      }
    } catch (e: any) {
      setError(e.message);
      if (pollRef.current) { clearInterval(pollRef.current); pollRef.current = null; }
    }
  }

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!query.trim()) return;

    stopTimers();
    setRunning(true);
    setError(null);
    setListings([]);
    setSyncResults(null);
    setStatus(null);
    setSyncPaintedMs(null);
    setBatchPaintedMs(null);
    setNowMs(0);

    try {
      // ── Shared prep: search ONCE (excluded from the timers) ──
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

      // ── Single starting gun for both columns ──
      t0Ref.current = Date.now();
      tickRef.current = setInterval(() => setNowMs(Date.now() - t0Ref.current), 100);

      // Column A: synchronous route — paints when its response lands.
      const syncP = (async () => {
        const res = await fetch(`${API_BASE}/api/internal/ebay-batch-test/sync-analyze`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          credentials: "include",
          body: JSON.stringify({ runId }),
        });
        const json = await res.json();
        if (!res.ok) throw new Error(json.error ?? `sync ${res.status}`);
        setSyncResults(json.results ?? []);
        setSyncPaintedMs(Date.now() - t0Ref.current);
      })();

      // Column B: batch submit (fast) then poll until terminal — paints on completion.
      const batchP = (async () => {
        const res = await fetch(`${API_BASE}/api/internal/ebay-batch-test/batch-submit`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          credentials: "include",
          body: JSON.stringify({ runId }),
        });
        const json = await res.json();
        if (!res.ok) throw new Error(json.error ?? `batch ${res.status}`);
        await poll(json.batchId);
        pollRef.current = setInterval(() => poll(json.batchId), POLL_MS);
      })();

      // Stop the live ticker once both settle (success or failure).
      await Promise.allSettled([syncP, batchP]);
    } catch (e: any) {
      setError(e.message);
    } finally {
      setRunning(false);
    }
  }

  // Stop the shared ticker once both columns have painted.
  useEffect(() => {
    maybeStopTicker(syncPaintedMs != null, batchPaintedMs != null);
  }, [syncPaintedMs, batchPaintedMs]);

  if (loading) return null;
  if (!user?.isAdmin) {
    return (
      <main className="admin-page">
        <p className="admin-forbidden">403 — Forbidden</p>
      </main>
    );
  }

  const syncTimer = syncPaintedMs ?? (listings.length ? nowMs : null);
  const batchTimer = batchPaintedMs ?? (listings.length ? nowMs : null);
  const syncByIndex = new Map<number, ResultRow>();
  syncResults?.forEach((r) => syncByIndex.set(r.index, r));
  const batchByIndex = new Map<number, ResultRow>();
  status?.results?.forEach((r) => batchByIndex.set(r.index, r));
  const batchTerminal = status && ["completed", "failed", "expired", "cancelled"].includes(status.status);

  return (
    <main className="admin-page">
      <Link to="/admin" className="admin-card-note" style={{ textDecoration: "underline" }}>← Back to Admin</Link>
      <h1 className="admin-heading">eBay Batch API — A/B Timing</h1>
      <p className="admin-card-note" style={{ maxWidth: 700, marginBottom: 16 }}>
        Search runs once (shared, not timed). Then both columns fire <strong>in parallel from a single t0</strong>,
        and each timer measures true click→painted in the browser — including network and poll latency.
        <strong> Synchronous</strong> = original route (shared TPM bucket); <strong>Batch API</strong> = async, separate TPM pool, ~50% token cost.
      </p>

      <form onSubmit={handleSubmit} style={{ display: "flex", gap: 8, flexWrap: "wrap", marginBottom: 24 }}>
        <input
          type="text"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="e.g. callaway ai smoke driver"
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
          {running ? "Running…" : "Search & Compare"}
        </button>
      </form>

      {error && <p className="admin-error">Error: {error}</p>}

      {listings.length > 0 && (
        <>
          <section className="admin-section">
            <div className="admin-cards" style={{ gridTemplateColumns: "repeat(2, 1fr)" }}>
              <div className="admin-card">
                <span className="admin-card-name">Synchronous route</span>
                <p className="admin-heading" style={{ margin: "6px 0", fontVariantNumeric: "tabular-nums" }}>{fmtMs(syncTimer)}</p>
                <span className="admin-card-note">
                  {syncPaintedMs != null ? "painted" : "running…"}
                  {syncResults ? ` · ${listings.length} listings` : ""}
                </span>
              </div>
              <div className="admin-card">
                <span className="admin-card-name">Batch API</span>
                <p className="admin-heading" style={{ margin: "6px 0", fontVariantNumeric: "tabular-nums" }}>{fmtMs(batchTimer)}</p>
                <span className="admin-card-note">
                  {batchPaintedMs != null ? "painted" : status ? `${status.status} · ${status.counts.completed}/${status.counts.total} (polling…)` : "submitting…"}
                </span>
                {batchTerminal && status?.providerMs != null && (
                  <span className="admin-card-note" style={{ marginTop: 4 }}>
                    Groq-measured: <strong>{fmtMs(status.providerMs)}</strong> total
                    {status.providerProcessingMs != null ? ` · ${fmtMs(status.providerProcessingMs)} compute` : ""}
                  </span>
                )}
              </div>
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
                      {l.price != null ? `${l.price} ${l.currency}` : "—"} · {l.condition ?? "—"}
                    </p>
                  </div>
                </div>

                <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 16 }}>
                  <div style={{ borderRight: "1px solid #2a2a2a", paddingRight: 16 }}>
                    <p className="admin-card-note" style={{ fontWeight: 600, marginBottom: 4 }}>Synchronous</p>
                    <ScoreCell r={syncByIndex.get(i)} />
                  </div>
                  <div>
                    <p className="admin-card-note" style={{ fontWeight: 600, marginBottom: 4 }}>Batch API</p>
                    <ScoreCell r={batchByIndex.get(i)} />
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
