import { useState } from "react";
import type { FormEvent } from "react";
import { Link } from "react-router-dom";
import { useAuth } from "../context/AuthContext";
import "./styles/AdminPage.css";

const API_BASE = import.meta.env.VITE_API_BASE_URL ?? "";

type ScoreMap = Record<string, number | null | undefined> | null;
type Stats = { provided?: number; attached?: number; stitched?: boolean } | null;

interface StrategyResult {
  scores: ScoreMap;
  overview: string;
  highlights: { label: string; positive: boolean }[];
  stats: Stats;
}

interface ListingResult {
  id: string | null;
  title: string | null;
  url: string | null;
  imageUrls: string[];
  perImage: StrategyResult;
  stitched: StrategyResult;
}

interface RunResponse {
  source: string;
  timing: { perImageMs: number; stitchedMs: number };
  fetchErrors: { id: string; error?: string }[];
  results: ListingResult[];
}

const EBAY_KEYS = ["priceFairness", "conditionHonesty", "shippingFairness", "descriptionQuality"];
const MP_KEYS = ["priceFairness", "sellerTrust", "conditionHonesty", "shippingFairness", "descriptionQuality"];

function num(v: unknown): number | null {
  return typeof v === "number" && !Number.isNaN(v) ? v : null;
}

function statLine(s: Stats): string {
  if (!s) return "n/a";
  return `provided=${s.provided ?? "?"} attached=${s.attached ?? "?"}${s.stitched ? " (stitched)" : ""}`;
}

export default function GridStitchDebugPage() {
  const { user, loading } = useAuth();
  const [source, setSource] = useState<"ebay" | "marketplace">("ebay");
  const [idsText, setIdsText] = useState("");
  const [data, setData] = useState<RunResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [running, setRunning] = useState(false);

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const ids = idsText.split(/[\s,]+/).map((s) => s.trim()).filter(Boolean);
    if (!ids.length) return;

    setRunning(true);
    setError(null);
    setData(null);
    try {
      const res = await fetch(`${API_BASE}/api/internal/grid-compare/run`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify({ source, ids }),
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error ?? `Request failed with ${res.status}`);
      setData(json);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Comparison failed");
    } finally {
      setRunning(false);
    }
  }

  if (loading) return null;

  if (!user?.isAdmin) {
    return (
      <main className="admin-page">
        <p className="admin-forbidden">403 — Forbidden</p>
      </main>
    );
  }

  const keys = source === "ebay" ? EBAY_KEYS : MP_KEYS;

  return (
    <main className="admin-page">
      <Link to="/admin" className="admin-back-link">Back to admin</Link>
      <h1 className="admin-heading">Grid Stitch A/B</h1>
      <p className="admin-card-note" style={{ maxWidth: 640, marginBottom: "1rem" }}>
        Scores each listing twice — per-image (current prod) vs. one stitched grid per listing — with no product
        context, so the only variable is image packing. Δ = stitched − per-image. A red Δ on conditionHonesty means
        stitching cost the model detail.
      </p>

      <section className="admin-section admin-tool-panel">
        <form className="admin-search-form" onSubmit={handleSubmit}>
          <div className="admin-search-row" style={{ marginBottom: "0.75rem" }}>
            <label className="admin-field-label" htmlFor="gs-source" style={{ marginRight: "0.5rem" }}>Source</label>
            <select
              id="gs-source"
              className="admin-text-input"
              value={source}
              onChange={(e) => setSource(e.target.value as "ebay" | "marketplace")}
              style={{ maxWidth: 180 }}
            >
              <option value="ebay">ebay</option>
              <option value="marketplace">marketplace</option>
            </select>
          </div>
          <label className="admin-field-label" htmlFor="gs-ids">
            Listing IDs or URLs (one per line or comma-separated — max 10). Paste eBay/Marketplace links directly.
          </label>
          <textarea
            id="gs-ids"
            className="admin-text-input"
            value={idsText}
            onChange={(e) => setIdsText(e.target.value)}
            placeholder={"156123456789\nhttps://www.facebook.com/marketplace/item/123456789012345"}
            rows={4}
            style={{ width: "100%", resize: "vertical", fontFamily: "ui-monospace, monospace" }}
          />
          <div className="admin-search-row" style={{ marginTop: "0.75rem" }}>
            <button className="admin-primary-button" type="submit" disabled={running || !idsText.trim()}>
              {running ? "Running 2 passes…" : "Run comparison"}
            </button>
          </div>
        </form>
      </section>

      {error && (
        <section className="admin-section">
          <p className="admin-error">{error}</p>
        </section>
      )}

      {data && (
        <section className="admin-section">
          <p className="admin-card-note">
            Timing: per-image {data.timing.perImageMs}ms · stitched {data.timing.stitchedMs}ms · saved{" "}
            {data.timing.perImageMs - data.timing.stitchedMs}ms
          </p>
          {data.fetchErrors.length > 0 && (
            <p className="admin-error">
              Failed to fetch: {data.fetchErrors.map((f) => `${f.id} (${f.error ?? ""})`).join(", ")}
            </p>
          )}

          {data.results.map((r, i) => (
            <div key={r.id ?? i} className="admin-tool-panel" style={{ marginBottom: "1rem", padding: "0.75rem" }}>
              <h2 className="admin-subheading" style={{ marginTop: 0 }}>
                {r.title ?? "(untitled)"}{" "}
                {r.url && (
                  <a href={r.url} target="_blank" rel="noreferrer" className="admin-debug-check">↗</a>
                )}
              </h2>
              <div style={{ marginBottom: "0.5rem" }}>
                {r.imageUrls.map((u) => (
                  <a key={u} href={u} target="_blank" rel="noreferrer">
                    <img className="admin-debug-thumb" src={u} alt="" loading="lazy" />
                  </a>
                ))}
              </div>

              <table className="admin-debug-table">
                <thead>
                  <tr>
                    <th>score</th>
                    <th>per-image</th>
                    <th>stitched</th>
                    <th>Δ</th>
                  </tr>
                </thead>
                <tbody>
                  {keys.map((k) => {
                    const a = num(r.perImage.scores?.[k]);
                    const b = num(r.stitched.scores?.[k]);
                    const d = a !== null && b !== null ? b - a : null;
                    const color = d === null ? "#888" : d > 0 ? "#d33" : d < 0 ? "#06c" : "#888";
                    return (
                      <tr key={k}>
                        <td>{k}</td>
                        <td>{a ?? "—"}</td>
                        <td>{b ?? "—"}</td>
                        <td style={{ color, fontWeight: 600 }}>{d === null ? "—" : `${d > 0 ? "+" : ""}${d}`}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
              <p className="admin-card-note">
                images: per-image {statLine(r.perImage.stats)} | stitched {statLine(r.stitched.stats)}
              </p>

              <table className="admin-debug-table" style={{ marginTop: "0.5rem" }}>
                <thead>
                  <tr>
                    <th>per-image overview</th>
                    <th>stitched overview</th>
                  </tr>
                </thead>
                <tbody>
                  <tr>
                    <td style={{ whiteSpace: "pre-wrap", verticalAlign: "top" }}>{r.perImage.overview || "—"}</td>
                    <td style={{ whiteSpace: "pre-wrap", verticalAlign: "top" }}>{r.stitched.overview || "—"}</td>
                  </tr>
                </tbody>
              </table>
            </div>
          ))}
        </section>
      )}
    </main>
  );
}
