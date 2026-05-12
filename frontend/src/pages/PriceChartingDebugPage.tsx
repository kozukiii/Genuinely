import { useState } from "react";
import type { FormEvent } from "react";
import { Link } from "react-router-dom";
import { useAuth } from "../context/AuthContext";
import "./styles/AdminPage.css";

const API_BASE = import.meta.env.VITE_API_BASE_URL ?? "";

type TitleRow = { id: string; title: string; imageUrl?: string | null };

type MatchState =
  | { status: "loading" }
  | { status: "found"; attemptedQueries: string[]; matchedQuery: string | null; url: string; debugLines: string[]; price?: number | null; grade?: number | null; gradedPrice?: number | null }
  | { status: "notfound"; attemptedQueries: string[]; debugLines: string[] }
  | { status: "error"; debugLines: string[] };

export default function PriceChartingDebugPage() {
  const { user, loading } = useAuth();
  const [term, setTerm] = useState("");
  const [rows, setRows] = useState<TitleRow[]>([]);
  const [matches, setMatches] = useState<Record<string, MatchState>>({});
  const [error, setError] = useState<string | null>(null);
  const [isSearching, setIsSearching] = useState(false);

  function setMatch(id: string, state: MatchState) {
    setMatches((prev) => ({ ...prev, [id]: state }));
  }

  async function runMatch(row: TitleRow) {
    setMatch(row.id, { status: "loading" });
    try {
      const params = new URLSearchParams({ title: row.title });
      const res = await fetch(`${API_BASE}/api/internal/pricecharting/match-title?${params}`, {
        credentials: "include",
      });
      const data = await res.json();
      const debugLines = Array.isArray(data.debugLines) ? data.debugLines : [];
      if (!res.ok) throw new Error(data.error ?? debugLines.join("\n"));
      if (data.found) {
        setMatch(row.id, { status: "found", attemptedQueries: data.attemptedQueries ?? [], matchedQuery: data.matchedQuery ?? null, url: data.url, debugLines, price: data.price ?? null, grade: data.grade ?? null, gradedPrice: data.gradedPrice ?? null });
      } else {
        setMatch(row.id, { status: "notfound", attemptedQueries: data.attemptedQueries ?? [], debugLines });
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
      const titles: TitleRow[] = (data.titles ?? []).map(({ id, title, imageUrl }: any) => ({ id, title, imageUrl: imageUrl ?? null }));
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
      <h1 className="admin-heading">PriceCharting Debug</h1>

      <section className="admin-section admin-tool-panel">
        <form className="admin-search-form" onSubmit={handleSubmit}>
          <label className="admin-field-label" htmlFor="pc-debug-term">
            Search term
          </label>
          <div className="admin-search-row">
            <input
              id="pc-debug-term"
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
                <th>PriceCharting Match</th>
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
                  <td>{row.title}</td>
                  <td><MatchCell match={matches[row.id]} /></td>
                </tr>
              ))}
            </tbody>
          </table>
        </section>
      )}
    </main>
  );
}

function MatchCell({ match }: { match: MatchState | undefined }) {
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
        <span className="admin-debug-x">✗</span>
        <span className="admin-debug-queries">
          {match.attemptedQueries.map((q) => (
            <span key={q} className="admin-debug-query">{q}</span>
          ))}
          <DebugLines lines={match.debugLines} />
        </span>
      </span>
    );
  }

  return (
    <span className="admin-debug-found">
      <a className="admin-debug-check" href={match.url} target="_blank" rel="noreferrer">✓</a>
      <span className="admin-debug-grade">
        {match.grade != null && `Grade ${match.grade} — `}
        {match.price != null ? `$${match.price.toFixed(2)}` : "no price"}
      </span>
      <span className="admin-debug-queries">
        {match.attemptedQueries.map((q) => {
          const isMatch = q === match.matchedQuery;
          return isMatch
            ? <a key={q} className="admin-debug-query admin-debug-query--link admin-debug-query--matched" href={match.url} target="_blank" rel="noreferrer">{q}</a>
            : <span key={q} className="admin-debug-query admin-debug-query--dim">{q}</span>;
        })}
        <DebugLines lines={match.debugLines} />
      </span>
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

