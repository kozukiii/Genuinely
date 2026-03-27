import { useLocation, useNavigate } from "react-router-dom";
import type { Listing } from "../types/Listing";
import RatingRing from "../components/RatingRing";
import "./styles/ListingPage.css";
import { useEffect, useMemo, useState } from "react";
import { getHighResImage } from "../utils/imageHelpers";
import { isSaved, toggleSaved, updateSavedListing } from "../utils/savedListings";
import { recordView, updateRecentlyViewed } from "../utils/recentlyViewed";

function sourceLabel(source?: Listing["source"]) {
  if (source === "marketplace") return "Marketplace";
  return "eBay";
}

export default function ListingPage() {
  const { state } = useLocation();
  const navigate = useNavigate();
  const listing = (state as any)?.listing as Listing | undefined;

  const [showOverview, setShowOverview] = useState(false);
  const [showDebug, setShowDebug] = useState(false);
  const [showRaw, setShowRaw] = useState(false);
  const [imageIndex, setImageIndex] = useState(0);
  const [saved, setSaved] = useState(false);
  const [enrichedImages, setEnrichedImages] = useState<string[] | null>(null);
  const [enrichedDescription, setEnrichedDescription] = useState<string | null>(null);
  const [enrichLoading, setEnrichLoading] = useState(false);
  const [analysisResult, setAnalysisResult] = useState<Partial<Listing> & { analyzedAt?: string } | null>(
    listing?.aiScore != null ? { ...listing, analyzedAt: undefined } : null
  );
  const [analyzing, setAnalyzing] = useState(false);
  const [analyzeError, setAnalyzeError] = useState<string | null>(null);

  useEffect(() => {
    if (!listing?.id) return;

    recordView(listing);
    setSaved(isSaved(listing.id));

    const onChange = () => setSaved(isSaved(listing.id));
    window.addEventListener("saved:listings:changed", onChange);
    return () => window.removeEventListener("saved:listings:changed", onChange);
  }, [listing?.id]);

  useEffect(() => {
    if (listing?.source !== "marketplace" || !listing?.id) return;
    setEnrichLoading(true);
    fetch(`/api/marketplace/item/${listing.id}`)
      .then((r) => { if (!r.ok) throw new Error(`HTTP ${r.status}`); return r.json(); })
      .then((data) => {
        if (Array.isArray(data.images) && data.images.length > 0) setEnrichedImages(data.images);
        if (typeof data.description === "string" && data.description.trim()) {
          setEnrichedDescription(data.description.trim());
        }
      })
      .catch((err) => console.warn("Marketplace enrichment failed:", err))
      .finally(() => setEnrichLoading(false));
  }, [listing?.id, listing?.source]);

  async function runAnalysis() {
    if (!listing) return;
    setAnalyzing(true);
    setAnalyzeError(null);
    try {
      const res = await fetch("/api/search/analyze", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(listing),
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error(body?.error ?? `HTTP ${res.status}`);
      }
      const data = await res.json();
      const enriched: Listing = { ...listing, ...data, analyzedAt: undefined };
      const withTs = { ...enriched, analyzedAt: data.analyzedAt ?? new Date().toISOString() };
      setAnalysisResult(withTs);

      // Persist enriched listing back to stores so cards reflect the score
      updateSavedListing(enriched);
      updateRecentlyViewed(enriched);

      // Replace router state so back-navigation restores the scored listing
      navigate(".", { replace: true, state: { listing: enriched } });
    } catch (err) {
      setAnalyzeError(err instanceof Error ? err.message : "Analysis failed");
    } finally {
      setAnalyzing(false);
    }
  }

  if (!listing) {
    return (
      <p style={{ padding: 20 }}>
        No listing data found. Go back to search and click a listing card again.
      </p>
    );
  }

  const images =
    enrichedImages !== null && enrichedImages.length > 0
      ? enrichedImages
      : listing.images ?? [];
  const safeIndex = Math.min(
    Math.max(imageIndex, 0),
    Math.max(images.length - 1, 0)
  );
  const currentImage = getHighResImage(
    images[safeIndex] ?? "",
    listing.source
  );

  const money = useMemo(() => {
    try {
      return new Intl.NumberFormat(undefined, {
        style: "currency",
        currency: listing.currency ?? "USD",
        maximumFractionDigits: 0,
      }).format(listing.price ?? 0);
    } catch {
      return `$${listing.price ?? 0}`;
    }
  }, [listing.price, listing.currency]);

  // Merge live analysis result over listing when available
  const ai = analysisResult ?? listing;

  const scores = {
    priceFairness: ai.aiScores?.priceFairness,
    sellerTrust: ai.aiScores?.sellerTrust,
    conditionHonesty: ai.aiScores?.conditionHonesty,
    shippingFairness: ai.aiScores?.shippingFairness,
    descriptionQuality: ai.aiScores?.descriptionQuality,
  };

  const readableLabels: Record<string, string> = {
    priceFairness: "Price Fairness",
    sellerTrust:
      listing.source === "marketplace" ? "Listing Confidence" : "Seller Trust",
    conditionHonesty: "Condition Honesty",
    shippingFairness:
      listing.source === "marketplace"
        ? "Pickup / Delivery Ease"
        : "Shipping Fairness",
    descriptionQuality:
      listing.source === "marketplace"
        ? "Listing Quality"
        : "Description Detail",
  };

  const sellerLine = useMemo(() => {
    if (listing.source === "marketplace") {
      return listing.location ? `📍 ${listing.location}` : null;
    }

    const seller = listing.seller?.trim();
    const feedback = listing.feedback?.trim();
    const score = listing.score;

    if (!seller && !feedback && score == null) return null;

    const parts: string[] = [];
    parts.push(`★ ${seller || "Seller"}`);

    if (feedback) parts.push(`— ${feedback}`);
    if (score != null) parts.push(`(${score})`);

    return parts.join(" ");
  }, [
    listing.source,
    listing.location,
    listing.seller,
    listing.feedback,
    listing.score,
  ]);

  return (
    <div className="listing-page">
      <div className="listing-card-block">
        <div className="page-image">
          <div className="image-frame">
            <img
              src={currentImage || "/placeholder.jpg"}
              alt={listing.title}
              onError={(e) => (e.currentTarget.src = "/placeholder.jpg")}
            />
            {enrichLoading && listing.source === "marketplace" && (
              <span className="image-loading-badge">Loading gallery…</span>
            )}
          </div>

          {images.length > 1 && (
            <div className="image-nav">
              <button
                onClick={() =>
                  setImageIndex((i) => (i === 0 ? images.length - 1 : i - 1))
                }
              >
                ‹
              </button>

              <span className="image-counter">
                {safeIndex + 1} / {images.length}
              </span>

              <button
                onClick={() =>
                  setImageIndex((i) => (i === images.length - 1 ? 0 : i + 1))
                }
              >
                ›
              </button>
            </div>
          )}
        </div>

        <div className="page-info">
          <h1 className="page-title">{listing.title}</h1>

          <div className="info-ring-row">
            <div className="info-column">
              <div className="price-heart-row">
                <p className="page-price">{money}</p>

                {listing.shippingPrice != null && (
                  <span className="page-shipping">
                    {listing.shippingPrice === 0
                      ? "Free shipping"
                      : `+ ${new Intl.NumberFormat(undefined, { style: "currency", currency: listing.currency ?? "USD", maximumFractionDigits: 0 }).format(listing.shippingPrice)} shipping`}
                  </span>
                )}

                <button
                  type="button"
                  className="page-heart-inline"
                  aria-pressed={saved}
                  aria-label={saved ? "Unsave listing" : "Save listing"}
                  onClick={(e) => {
                    e.preventDefault();
                    e.stopPropagation();
                    const next = toggleSaved(listing);
                    setSaved(next);
                  }}
                >
                  {saved ? "♥" : "♡"}
                </button>
              </div>

              {listing.condition && (
                <span className="page-condition">{listing.condition}</span>
              )}

              {sellerLine && <p className="page-seller">{sellerLine}</p>}
            </div>

            {ai.aiScore != null && (
              <div className="page-rating-ring">
                <RatingRing value={ai.aiScore} size={80} />
                <p className="page-rating-label">{ai.aiScore}/100</p>
              </div>
            )}
          </div>

          {(enrichedDescription || listing.description) && (
            <p className="page-description">{enrichedDescription || listing.description}</p>
          )}

          <div className="analyze-row">
            <button
              className="analyze-btn"
              onClick={runAnalysis}
              disabled={analyzing}
            >
              {analyzing
                ? "Analyzing…"
                : analysisResult?.analyzedAt
                ? "Re-analyze"
                : ai.aiScore != null
                ? "Re-analyze"
                : "Analyze listing"}
            </button>

            {analysisResult?.analyzedAt && (
              <p className="analyze-subtext">
                Last analyzed {new Date(analysisResult.analyzedAt).toLocaleString()}
              </p>
            )}
            {!analysisResult?.analyzedAt && ai.aiScore != null && (
              <p className="analyze-subtext">Previously analyzed</p>
            )}
            {analyzeError && (
              <p className="analyze-error">{analyzeError}</p>
            )}
          </div>

          <a
            className="external-ebay-link"
            href={listing.url}
            target="_blank"
            rel="noopener noreferrer"
          >
            View on {sourceLabel(listing.source)} →
          </a>
        </div>
      </div>

      {ai.aiScore != null && (
        <div className="ai-analysis-box">
          <div className="ai-analysis-header">
            <RatingRing value={ai.aiScore} size={80} />
            <div>
              <p className="ai-analysis-main">
                Our AI analysis rated this listing {ai.aiScore}/100.
              </p>

              <button
                className="ai-toggle-btn"
                onClick={() => setShowOverview(!showOverview)}
              >
                {showOverview ? "Hide details ↑" : "Click to see why ↓"}
              </button>
            </div>
          </div>

          {showOverview && (
            <div className="ai-overview-dropdown">
              {ai.aiScores && (
                <div className="ai-score-grid">
                  {Object.entries(scores).map(([key, value]) => {
                    if (value == null) return null;
                    return (
                      <div key={key} className="ai-score-item">
                        <p className="ring-title">{readableLabels[key]}</p>
                        <RatingRing value={value} size={65} />
                      </div>
                    );
                  })}
                </div>
              )}

              <h3>Summary</h3>
              <p>{ai.overview}</p>

              <button
                className="ai-debug-toggle"
                onClick={() => setShowDebug(!showDebug)}
              >
                {showDebug ? "Hide debug ↑" : "Show debug info ↓"}
              </button>

              {showDebug && (
                <pre className="debug-block">{ai.debugInfo}</pre>
              )}

              <button
                className="ai-debug-toggle"
                onClick={() => setShowRaw(!showRaw)}
              >
                {showRaw ? "Hide raw AI output ↑" : "Show raw AI output ↓"}
              </button>

              {showRaw && (
                <pre className="debug-block">{ai.rawAnalysis}</pre>
              )}
            </div>
          )}
        </div>
      )}
    </div>
  );
}