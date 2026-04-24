import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { useAuth } from "../context/AuthContext";
import "./styles/AdminPage.css";

const API_BASE = import.meta.env.VITE_API_BASE_URL ?? "";

type ProviderUsage = {
  name: string;
  used: number | null;
  limit: number | null;
  remaining: number | null;
  percentUsed: number | null;
  status: "ok" | "warning" | "critical" | "unknown";
  resetTime?: string | null;
  note?: string | null;
  highlight?: string | null;
};

function StatusBadge({ status }: { status: ProviderUsage["status"] }) {
  return <span className={`admin-status admin-status--${status}`}>{status}</span>;
}

function RingChart({ percent }: { percent: number }) {
  const r = 38;
  const circ = 2 * Math.PI * r;
  const offset = circ * (1 - percent / 100);
  const id = "ringGrad-admin";

  return (
    <svg className="admin-ring" viewBox="0 0 100 100" aria-label={`${percent}% used`}>
      <defs>
        <linearGradient id={id} x1="0%" y1="0%" x2="100%" y2="100%">
          <stop offset="0%" stopColor="#3dff8f" />
          <stop offset="100%" stopColor="#1aad54" />
        </linearGradient>
      </defs>
      {/* Track */}
      <circle cx="50" cy="50" r={r} fill="none" stroke="#222" strokeWidth="7" />
      {/* Progress */}
      <circle
        cx="50" cy="50" r={r}
        fill="none"
        stroke={`url(#${id})`}
        strokeWidth="7"
        strokeLinecap="round"
        strokeDasharray={circ}
        strokeDashoffset={offset}
        transform="rotate(-90 50 50)"
      />
      <text x="50" y="50" dominantBaseline="central" textAnchor="middle" className="admin-ring-label">
        {percent}%
      </text>
    </svg>
  );
}

export default function AdminPage() {
  const { user, loading } = useAuth();
  const [providers, setProviders] = useState<ProviderUsage[]>([]);
  const [fetchError, setFetchError] = useState<string | null>(null);

  useEffect(() => {
    if (!user?.isAdmin) return;
    fetch(`${API_BASE}/api/internal/usage`, { credentials: "include" })
      .then((r) => {
        if (!r.ok) throw new Error(`${r.status}`);
        return r.json();
      })
      .then((data) => setProviders(data.providers ?? []))
      .catch((e) => setFetchError(e.message));
  }, [user]);

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
      <h1 className="admin-heading">Admin</h1>

      <section className="admin-section">
        <h2 className="admin-subheading">Tools</h2>
        <div className="admin-cards">
          <Link to="/listingcard-demo" className="admin-card admin-card--link">
            <span className="admin-card-name">Listing Card Demo</span>
            <span className="admin-card-note">Interactive demo of the analysis flow</span>
          </Link>
          <Link to="/search-demo" className="admin-card admin-card--link">
            <span className="admin-card-name">Search Page Demo</span>
            <span className="admin-card-note">16 mixed listings, all scored 100</span>
          </Link>
        </div>
      </section>

      <section className="admin-section">
        <h2 className="admin-subheading">Provider Usage</h2>
        {fetchError && <p className="admin-error">Failed to load: {fetchError}</p>}
        {providers.length === 0 && !fetchError && <p className="admin-empty">No data.</p>}
        <div className="admin-cards">
          {providers.map((p) => (
            <div key={p.name} className="admin-card">
              <div className="admin-card-header">
                <span className="admin-card-name">{p.name}</span>
                <StatusBadge status={p.status} />
              </div>

              {p.percentUsed !== null
                ? <RingChart percent={p.percentUsed} />
                : p.highlight && <p className="admin-card-highlight">{p.highlight}</p>
              }

              {p.note && <p className="admin-card-note">{p.note}</p>}
              {p.resetTime && <p className="admin-card-note">Resets: {p.resetTime}</p>}
            </div>
          ))}
        </div>
      </section>
    </main>
  );
}
