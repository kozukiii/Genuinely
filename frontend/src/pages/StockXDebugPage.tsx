import { useEffect, useState } from "react";
import type { FormEvent } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { useAuth } from "../context/AuthContext";
import "./styles/AdminPage.css";

const API_BASE = import.meta.env.VITE_API_BASE_URL ?? "";

type TitleRow = { id: string; title: string; imageUrl?: string | null };

type MatchState =
  | { status: "loading" }
  | {
      status: "found";
      productTitle: string | null;
      productUrl: string | null;
      styleId: string | null;
      size: string | null;
      detectedSize: string | null;
      lowestAsk: number | null;
      highestBid: number | null;
      debugLines: string[];
    }
  | { status: "notfound"; debugLines: string[] }
  | { status: "error"; debugLines: string[] };

export default function StockXDebugPage() {
  const { user, loading } = useAuth();
  const [searchParams] = useSearchParams();
  const [term, setTerm] = useState("");
  const [rows, setRows] = useState<TitleRow[]>([]);
  const [matches, setMatches] = useState<Record<string, MatchState>>({});
  const [error, setError] = useState<string | null>(null);
  const [isSearching, setIsSearching] = useState(false);
  const [connected, setConnected] = useState<boolean | null>(null);

  useEffect(() => {
    if (!user?.isAdmin) return;
    fetch(`${API_BASE}/api/internal/stockx/status`, { credentials: "include" })
      .then((r) => r.json())
      .then((d) => setConnected(!!d.connected))
      .catch(() => setConnected(false));
  }, [user, searchParams]);

  function setMatch(id: string, state: MatchState) {
    setMatches((prev) => ({ ...prev, [id]: state }));
  }

  async function connectStockX() {
    const res = await fetch(`${API_BASE}/api/internal/stockx/auth-url`, { credentials: "include" });
    const data = await res.json();
    if (data.url) window.location.href = data.url;
    else setError(data.error ?? "Failed to build StockX auth URL");
  }

  async function disconnectStockX() {
    try {
      await fetch(`${API_BASE}/api/internal/stockx/disconnect`, {
        method: "POST",
        credentials: "include",
      });
      setConnected(false);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to disconnect StockX");
    }
  }

  async function runMatch(row: TitleRow) {
    setMatch(row.id, { status: "loading" });
    try {
      const params = new URLSearchParams({ title: row.title });
      const res = await fetch(`${API_BASE}/api/internal/stockx/match-title?${params}`, {
        credentials: "include",
      });
      const data = await res.json();
      const debugLines = Array.isArray(data.debugLines) ? data.debugLines : [];
      if (!res.ok) throw new Error(data.error ?? debugLines.join("\n"));
      if (data.found) {
        setMatch(row.id, {
          status: "found",
          productTitle: data.productTitle ?? null,
          productUrl: data.productUrl ?? null,
          styleId: data.styleId ?? null,
          size: data.size ?? null,
          detectedSize: data.detectedSize ?? null,
          lowestAsk: data.lowestAsk ?? null,
          highestBid: data.highestBid ?? null,
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
      <h1 className="admin-heading">StockX Debug</h1>

      <section className="admin-section admin-tool-panel">
        <div className="admin-search-row" style={{ marginBottom: "0.75rem" }}>
          <span className={`admin-status admin-status--${connected ? "ok" : "warning"}`}>
            {connected === null ? "checking…" : connected ? "connected" : "not connected"}
          </span>
          {connected === false && (
            <button className="admin-primary-button" type="button" onClick={connectStockX}>
              Connect StockX
            </button>
          )}
          {connected === true && (
            <button className="admin-primary-button" type="button" onClick={disconnectStockX}>
              Sign out of StockX
            </button>
          )}
        </div>

        <form className="admin-search-form" onSubmit={handleSubmit}>
          <label className="admin-field-label" htmlFor="sx-debug-term">
            Search term
          </label>
          <div className="admin-search-row">
            <input
              id="sx-debug-term"
              className="admin-text-input"
              type="text"
              value={term}
              onChange={(e) => setTerm(e.target.value)}
              placeholder="e.g. Jordan 4 Bred size 10"
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
                <th>StockX Match</th>
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
        <DebugLines lines={match.debugLines} />
      </span>
    );
  }

  const sizeMismatch = match.detectedSize && match.size && match.detectedSize !== match.size;
  // StockX sometimes returns amounts as strings, so coerce before formatting
  // (a bare n.toFixed() throws and blanks the page when n is a string).
  const fmt = (n: number | null) => {
    const num = typeof n === "number" ? n : Number(n);
    return n != null && Number.isFinite(num) ? `$${num.toFixed(2)}` : "—";
  };

  return (
    <span className="admin-debug-found">
      {match.productUrl ? (
        <a className="admin-debug-check" href={match.productUrl} target="_blank" rel="noreferrer">
          ✓ {match.productTitle ?? "View on StockX"}
        </a>
      ) : (
        <span className="admin-debug-check">✓ {match.productTitle}</span>
      )}
      <span className="admin-debug-grade">
        {match.size != null && `Size ${match.size}`}
        {sizeMismatch && ` (wanted ${match.detectedSize})`}
        {" — "}
        <strong>Ask {fmt(match.lowestAsk)}</strong>
        {" / "}
        <span>Bid {fmt(match.highestBid)}</span>
      </span>
      {match.styleId && <span className="admin-debug-query admin-debug-query--dim">{match.styleId}</span>}
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
