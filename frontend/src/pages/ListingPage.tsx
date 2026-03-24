import { useLocation } from "react-router-dom";
import type { Listing } from "../types/Listing";
import RatingRing from "../components/RatingRing";
import "./styles/ListingPage.css";
import { useEffect, useMemo, useState } from "react";
import { getHighResImage } from "../utils/imageHelpers";

// NEW
import { isSaved, toggleSaved } from "../utils/savedListings";

function sourceLabel(source?: Listing["source"]) {
  if (source === "marketplace") return "Marketplace";
  return "eBay";
}

export default function ListingPage() {
  const { state } = useLocation();

  // state can be undefined on refresh/direct link
  const listing = (state as any)?.listing as Listing | undefined;

  const [showOverview, setShowOverview] = useState(false);
  const [showDebug, setShowDebug] = useState(false);
  const [showRaw, setShowRaw] = useState(false);
  const [imageIndex, setImageIndex] = useState(0);

  // NEW: saved state
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    if (!listing?.id) return;

    // initialize saved status
    setSaved(isSaved(listing.id));

    // keep in sync if saved changes elsewhere
    const onChange = () => setSaved(isSaved(listing.id));
    window.addEventListener("saved:listings:changed", onChange);
    return () => window.removeEventListener("saved:listings:changed", onChange);
  }, [listing?.id]);

  if (!listing) {
    return (
      <p style={{ padding: 20 }}>
        No listing data found. Go back to search and click a listing card again.
      </p>
    );
  }

  const images = listing.images ?? [];
  const safeIndex = Math.min(
    Math.max(imageIndex, 0),
    Math.max(images.length - 1, 0),
  );
  const currentImage = getHighResImage(images[safeIndex] ?? "");

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

  const scores = {
    priceFairness: listing.aiScores?.priceFairness,
    sellerTrust: listing.aiScores?.sellerTrust,
    conditionHonesty: listing.aiScores?.conditionHonesty,
    shippingFairness: listing.aiScores?.shippingFairness,
    descriptionQuality: listing.aiScores?.descriptionQuality,
  };

  const readableLabels: Record<string, string> = {
    priceFairness: "Price Fairness",
    sellerTrust: "Seller Trust",
    conditionHonesty: "Condition Honesty",
    shippingFairness: "Shipping Fairness",
    descriptionQuality: "Description Detail",
  };

  // Seller line formatting (no "undefined%")
  const sellerLine = useMemo(() => {
    const seller = listing.seller?.trim();
    const feedback = listing.feedback?.trim();
    const score = listing.score;

    if (!seller && !feedback && score == null) return null;

    const parts: string[] = [];
    parts.push(`★ ${seller || "Seller"}`);

    if (feedback) parts.push(`— ${feedback}`);
    if (score != null) parts.push(`(${score})`);

    return parts.join(" ");
  }, [listing.seller, listing.feedback, listing.score]);

  return (
    <div className="listing-page">
      {/* TOP SECTION */}
      <div className="listing-card-block">
        <div className="page-image">
          <div className="image-frame">
            <img
              src={currentImage || "/placeholder.jpg"}
              alt={listing.title}
              onError={(e) => (e.currentTarget.src = "/placeholder.jpg")}
            />

            
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

            {listing.aiScore != null && (
              <div className="page-rating-ring">
                <RatingRing value={listing.aiScore} size={80} />
                <p className="page-rating-label">{listing.aiScore}/100</p>
              </div>
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

      {/* AI ANALYSIS */}
      {listing.aiScore != null && (
        <div className="ai-analysis-box">
          <div className="ai-analysis-header">
            <RatingRing value={listing.aiScore} size={80} />
            <div>
              <p className="ai-analysis-main">
                Our AI analysis rated this listing {listing.aiScore}/100.
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
              {listing.aiScores && (
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
              <p>{listing.overview}</p>

              <button
                className="ai-debug-toggle"
                onClick={() => setShowDebug(!showDebug)}
              >
                {showDebug ? "Hide debug ↑" : "Show debug info ↓"}
              </button>

              {showDebug && (
                <pre className="debug-block">{listing.debugInfo}</pre>
              )}

              <button
                className="ai-debug-toggle"
                onClick={() => setShowRaw(!showRaw)}
              >
                {showRaw ? "Hide raw AI output ↑" : "Show raw AI output ↓"}
              </button>

              {showRaw && (
                <pre className="debug-block">{listing.rawAnalysis}</pre>
              )}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
