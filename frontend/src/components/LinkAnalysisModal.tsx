import { useState } from "react";
import { useNavigate } from "react-router-dom";
import type { Listing } from "../types/Listing";
import "./styles/LinkAnalysisModal.css";

const API_BASE = import.meta.env.VITE_API_BASE_URL ?? "";

interface Props {
  onClose: () => void;
}

export default function LinkAnalysisModal({ onClose }: Props) {
  const [url, setUrl] = useState("");
  const [phase, setPhase] = useState<"idle" | "fetching" | "analyzing" | "error">("idle");
  const [errorMsg, setErrorMsg] = useState("");
  const navigate = useNavigate();

  async function handleSubmit() {
    const trimmed = url.trim();
    if (!trimmed) return;
    setPhase("fetching");
    setErrorMsg("");

    try {
      // Short delay so the "Fetching listing…" label is visible before analysis starts
      await new Promise((r) => setTimeout(r, 400));
      setPhase("analyzing");

      const res = await fetch(`${API_BASE}/api/search/from-url`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ url: trimmed }),
      });

      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error(body?.error ?? `HTTP ${res.status}`);
      }

      const listing: Listing = await res.json();
      onClose();
      navigate(`/listing/${listing.id}`, { state: { listing } });
    } catch (err) {
      setPhase("error");
      setErrorMsg(err instanceof Error ? err.message : "Failed to load listing");
    }
  }

  const loading = phase === "fetching" || phase === "analyzing";

  const statusLabel = phase === "fetching"
    ? "Fetching listing…"
    : phase === "analyzing"
    ? "Analyzing…"
    : "Analyze";

  return (
    <div
      className="lam-backdrop"
      onClick={(e) => {
        if (e.target === e.currentTarget && !loading) onClose();
      }}
    >
      <div className="lam-card">
        <button
          className="lam-close"
          onClick={onClose}
          disabled={loading}
          aria-label="Close"
        >
          ✕
        </button>

        <h2 className="lam-title">Analyze a listing</h2>
        <p className="lam-hint">
          Paste an eBay or Facebook Marketplace link for an instant AI analysis.
        </p>

        <div className="lam-input-row">
          <input
            className="lam-input"
            type="url"
            placeholder="https://www.ebay.com/itm/..."
            value={url}
            onChange={(e) => setUrl(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && !loading && handleSubmit()}
            autoFocus
            disabled={loading}
          />
          <button
            className="lam-submit"
            onClick={handleSubmit}
            disabled={loading || !url.trim()}
          >
            {statusLabel}
          </button>
        </div>

        {loading && (
          <div className="lam-progress">
            <span className="lam-spinner" />
            <span className="lam-progress-label">{statusLabel}</span>
          </div>
        )}

        {phase === "error" && (
          <p className="lam-error">{errorMsg}</p>
        )}
      </div>
    </div>
  );
}
