import { useState } from "react";
import type { FormEvent } from "react";
import { Link } from "react-router-dom";
import { useAuth } from "../context/AuthContext";
import "./styles/AdminPage.css";
import "./styles/ListingPage.css";

const API_BASE = import.meta.env.VITE_API_BASE_URL ?? "";

type TitleRow = { id: string; title: string; imageUrl?: string | null };

type SerperMatchState =
  | { status: "loading" }
  | {
      status: "found";
      pcUrl: string;
      serperSnippet: string | null;
      scrapedTitle: string;
      grade: number | null;
      loosePrice: number | null;
      completePrice: number | null;
      newPrice: number | null;
      gradedPrice: number | null;
      gradedSaleLow: number | null;
      gradedSaleHigh: number | null;
      tcgPlayerPrice: number | null;
      tcgPlayerUrl: string | null;
      chartLow: number | null;
      chartHigh: number | null;
      debugLines: string[];
    }
  | { status: "notfound"; debugLines: string[] }
  | { status: "error"; debugLines: string[] };

function buildPriceBarProps(priceLow: number, priceHigh: number) {
  // When there's only one price point, create a small artificial range so the bar renders
  const spread   = priceHigh > priceLow ? priceHigh - priceLow : priceLow * 0.1 || 1;
  const ext      = spread * 0.18;
  const barMin   = (priceLow  - ext);
  const barMax   = (priceHigh + ext);
  const barRange = barMax - barMin;
  const lowPct   = ((priceLow  - barMin) / barRange) * 100;
  const midPct   = (((priceLow + priceHigh) / 2 - barMin) / barRange) * 100;
  const highPct  = ((priceHigh - barMin) / barRange) * 100;
  return { lowPct, midPct, highPct };
}

export default function SerperSourceMatchDemoPage() {
  const { user, loading } = useAuth();
  const [term, setTerm] = useState("");
  const [rows, setRows] = useState<TitleRow[]>([]);
  const [matches, setMatches] = useState<Record<string, SerperMatchState>>({});
  const [error, setError] = useState<string | null>(null);
  const [isSearching, setIsSearching] = useState(false);

  function setMatch(id: string, state: SerperMatchState) {
    setMatches((prev) => ({ ...prev, [id]: state }));
  }

  async function runMatch(row: TitleRow) {
    setMatch(row.id, { status: "loading" });
    try {
      const params = new URLSearchParams({ title: row.title });
      const res = await fetch(`${API_BASE}/api/internal/serper/source-match?${params}`, {
        credentials: "include",
      });
      const data = await res.json();
      const debugLines = Array.isArray(data.debugLines) ? data.debugLines : [];
      if (!res.ok) throw new Error(data.error ?? debugLines.join("\n"));
      if (data.found) {
        setMatch(row.id, {
          status: "found",
          pcUrl: data.pcUrl,
          serperSnippet: data.serperSnippet ?? null,
          scrapedTitle: data.scrapedTitle,
          grade: data.grade ?? null,
          loosePrice: data.loosePrice ?? null,
          completePrice: data.completePrice ?? null,
          newPrice: data.newPrice ?? null,
          gradedPrice: data.gradedPrice ?? null,
          gradedSaleLow: data.gradedSaleLow ?? null,
          gradedSaleHigh: data.gradedSaleHigh ?? null,
          tcgPlayerPrice: data.tcgPlayerPrice ?? null,
          tcgPlayerUrl: data.tcgPlayerUrl ?? null,
          chartLow: data.chartLow ?? null,
          chartHigh: data.chartHigh ?? null,
          debugLines,
        });
      } else {
        setMatch(row.id, { status: "notfound", debugLines });
      }
    } catch (err) {
      setMatch(row.id, { status: "error", debugLines: [err instanceof Error ? err.message : "Match failed"] });
    }
  }

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const query = term.trim();
    if (!query) return;

    setIsSearching(true);
    setError(null);
    setRows([]);
    setMatches({});

    try {
      const params = new URLSearchParams({ query, limit: "5" });
      const res = await fetch(`${API_BASE}/api/internal/ebay/listing-titles?${params}`, {
        credentials: "include",
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? `Request failed with ${res.status}`);
      const titles: TitleRow[] = (data.titles ?? []).map(({ id, title, imageUrl }: any) => ({
        id,
        title,
        imageUrl: imageUrl ?? null,
      }));
      setRows(titles);
      titles.forEach(runMatch);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to fetch listings");
    } finally {
      setIsSearching(false);
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

  return (
    <main className="admin-page">
      <Link to="/admin" className="admin-back-link">Back to admin</Link>
      <h1 className="admin-heading">Serper Source Matching Demo</h1>

      <section className="admin-section admin-tool-panel">
        <form className="admin-search-form" onSubmit={handleSubmit}>
          <label className="admin-field-label" htmlFor="serper-match-term">
            Search term
          </label>
          <div className="admin-search-row">
            <input
              id="serper-match-term"
              className="admin-text-input"
              type="text"
              value={term}
              onChange={(e) => setTerm(e.target.value)}
              placeholder="e.g. Pokemon Charizard"
              autoComplete="off"
            />
            <button className="admin-primary-button" type="submit" disabled={isSearching || !term.trim()}>
              {isSearching ? "Searching..." : "Search"}
            </button>
          </div>
        </form>
      </section>

      {error && (
        <section className="admin-section">
          <p className="admin-error">{error}</p>
        </section>
      )}

      {rows.length > 0 && (
        <section className="admin-section">
          <table className="admin-debug-table">
            <thead>
              <tr>
                <th>Image</th>
                <th>eBay Title</th>
                <th>Serper Match</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => (
                <tr key={row.id}>
                  <td>
                    {row.imageUrl ? (
                      <a href={row.imageUrl} target="_blank" rel="noreferrer">
                        <img className="admin-debug-thumb" src={row.imageUrl} alt="" />
                      </a>
                    ) : (
                      <span className="admin-debug-x">✗</span>
                    )}
                  </td>
                  <td>
                    <a href={`https://www.ebay.com/itm/${row.id}`} target="_blank" rel="noreferrer" style={{ color: "inherit", textDecoration: "underline" }}>
                      {row.title}
                    </a>
                  </td>
                  <td><SerperMatchCell match={matches[row.id]} ebayUrl={`https://www.ebay.com/itm/${row.id}`} /></td>
                </tr>
              ))}
            </tbody>
          </table>
        </section>
      )}
    </main>
  );
}

function fmt(n: number | null): string {
  return n != null ? `$${n.toFixed(2)}` : "—";
}

function SerperMatchCell({ match, ebayUrl }: { match: SerperMatchState | undefined; ebayUrl: string }) {
  if (!match || match.status === "loading") {
    return <span className="admin-debug-loading">…</span>;
  }

  if (match.status === "error") {
    return (
      <span className="admin-debug-notfound">
        <span className="admin-debug-x">X</span>
        <DebugLines lines={match.debugLines} />
      </span>
    );
  }

  if (match.status === "notfound") {
    return (
      <span className="admin-debug-notfound">
        <span className="admin-debug-x">✗</span> No PriceCharting link found
        <DebugLines lines={match.debugLines} />
      </span>
    );
  }

  const hasChart = match.chartLow !== null && match.chartHigh !== null;
  const barProps = hasChart ? buildPriceBarProps(match.chartLow!, match.chartHigh!) : null;

  const primaryPrice = match.grade != null ? match.gradedPrice : match.loosePrice;
  const primaryLabel = match.grade != null ? `Grade ${match.grade}` : "Loose";

  return (
    <span className="admin-debug-found" style={{ display: "flex", flexDirection: "column", gap: "6px" }}>
      <span className="admin-debug-grade">
        <a href={match.pcUrl} target="_blank" rel="noreferrer" style={{ color: "inherit", textDecoration: "underline" }}>
          {match.scrapedTitle}
        </a>
        {match.grade != null && (
          <span style={{ marginLeft: "8px", color: "#f5a623", fontWeight: 600 }}>Grade {match.grade}</span>
        )}
      </span>

      {/* Price bar chart */}
      {barProps && (
        <div className="demo-score-bar-wrap" style={{ marginTop: "2px" }}>
          <div className="demo-score-bar-box">
            <div className="demo-score-bar-track">
              <span className="demo-score-tick" style={{ left: `${barProps.lowPct}%` }} />
              <span className="demo-score-tick" style={{ left: `${barProps.midPct}%`, transform: "translateX(-50%)" }} />
              <span className="demo-score-tick" style={{ left: `${barProps.highPct}%`, transform: "translateX(-100%)" }} />
              <span className="demo-score-label-end" style={{ left: `${barProps.lowPct}%` }}>
                {match.grade != null ? "Low sale" : "Low"} · {fmt(match.chartLow)}
              </span>
              <span className="demo-score-label-end" style={{ left: `${barProps.highPct}%` }}>
                {match.grade != null ? "High sale" : "High"} · {fmt(match.chartHigh)}
              </span>
            </div>
          </div>

          {/* Source chips */}
          <div className="market-price-sources">
            <span className="market-price-sources__label">Sources</span>
            <div className="market-price-links">
              <a className="price-source-chip" href={match.pcUrl} target="_blank" rel="noreferrer" title="View on PriceCharting">
                <img src="https://www.google.com/s2/favicons?domain=pricecharting.com&sz=32" alt="" className="price-source-chip__icon" />
                <span>PriceCharting {primaryPrice != null ? `· ${fmt(primaryPrice)} (${primaryLabel})` : ""}</span>
              </a>
              {match.tcgPlayerUrl && match.tcgPlayerPrice != null && (
                <a className="price-source-chip" href={match.tcgPlayerUrl} target="_blank" rel="noreferrer" title="View on TCGPlayer">
                  <img src="https://www.google.com/s2/favicons?domain=tcgplayer.com&sz=32" alt="" className="price-source-chip__icon" />
                  <span>TCGPlayer · {fmt(match.tcgPlayerPrice)}</span>
                </a>
              )}
              <a className="price-source-chip" href={ebayUrl} target="_blank" rel="noreferrer" title="View on eBay">
                <img src="https://www.google.com/s2/favicons?domain=ebay.com&sz=32" alt="" className="price-source-chip__icon" />
                <span>eBay listing</span>
              </a>
            </div>
          </div>
        </div>
      )}

      {/* Fallback price row when chart can't be drawn */}
      {!hasChart && (
        <table style={{ borderCollapse: "collapse", fontSize: "0.85em" }}>
          <tbody>
            {primaryPrice != null && (
              <tr>
                <td style={{ paddingRight: "12px", fontWeight: 600, color: match.grade != null ? "#f5a623" : "inherit" }}>{primaryLabel}</td>
                <td style={{ fontWeight: 700 }}>{fmt(primaryPrice)}</td>
              </tr>
            )}
            {match.tcgPlayerPrice != null && (
              <tr>
                <td style={{ paddingRight: "12px", color: "#3dff8f" }}>
                  {match.tcgPlayerUrl
                    ? <a href={match.tcgPlayerUrl} target="_blank" rel="noreferrer" style={{ color: "#3dff8f" }}>TCGPlayer ↗</a>
                    : "TCGPlayer"
                  }
                </td>
                <td style={{ color: "#3dff8f", fontWeight: 600 }}>{fmt(match.tcgPlayerPrice)}</td>
              </tr>
            )}
          </tbody>
        </table>
      )}

      {match.serperSnippet && (
        <span className="admin-debug-query admin-debug-query--dim">{match.serperSnippet}</span>
      )}
      <DebugLines lines={match.debugLines} />
    </span>
  );
}

function DebugLines({ lines }: { lines: string[] }) {
  if (!lines.length) return null;
  return (
    <details className="admin-debug-lines">
      <summary>debug</summary>
      <pre>{lines.join("\n")}</pre>
    </details>
  );
}
