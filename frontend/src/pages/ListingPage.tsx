import { useLocation } from "react-router-dom";
import type { Listing } from "../types/Listing";
import RatingRing from "../components/RatingRing";
import "./styles/ListingPage.css";
import { useEffect, useState } from "react";
import { getHighResImage } from "../utils/imageHelpers";

export default function ListingPage() {
  const { state } = useLocation();
  const listing = state?.listing as Listing;

  const [showOverview, setShowOverview] = useState(false);
  const [showDebug, setShowDebug] = useState(false);
  const [showRaw, setShowRaw] = useState(false);

  const images =
    listing?.images && listing.images.length > 0
      ? listing.images
      : listing?.image
        ? [listing.image]
        : [];

  const [currentIndex, setCurrentIndex] = useState(0);

  useEffect(() => {
    if (images.length <= 1) return;

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "ArrowRight") {
        setCurrentIndex((prev) => (prev + 1) % images.length);
      } else if (event.key === "ArrowLeft") {
        setCurrentIndex((prev) => (prev - 1 + images.length) % images.length);
      }
    };

    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [images.length]);

  if (!listing) {
    return <p style={{ padding: 20 }}>No listing data found.</p>;
  }

  const highResImage = getHighResImage(images[currentIndex]);

  // Remove locationRisk from UI
  const scores = {
    priceFairness: listing.aiScores?.priceFairness,
    sellerTrust: listing.aiScores?.sellerTrust,
    conditionHonesty: listing.aiScores?.conditionHonesty,
    shippingFairness: listing.aiScores?.shippingFairness,
    descriptionQuality: listing.aiScores?.descriptionQuality
  };

  const readableLabels: Record<string, string> = {
    priceFairness: "Price Fairness",
    sellerTrust: "Seller Trust",
    conditionHonesty: "Condition Honesty",
    shippingFairness: "Shipping Fairness",
    descriptionQuality: "Description Detail"
  };

  return (
    <div className="listing-page">

      {/* TOP SECTION */}
      <div className="listing-card-block">
        <div className="page-image">
          <div className="image-carousel" aria-live="polite">
            <button
              className="carousel-nav"
              onClick={() =>
                setCurrentIndex((prev) => (prev - 1 + images.length) % images.length)
              }
              disabled={images.length <= 1}
              aria-label="Previous image"
            >
              ←
            </button>

            <img src={highResImage} alt={listing.title} />

            <button
              className="carousel-nav"
              onClick={() => setCurrentIndex((prev) => (prev + 1) % images.length)}
              disabled={images.length <= 1}
              aria-label="Next image"
            >
              →
            </button>
          </div>

          {images.length > 1 && (
            <div className="carousel-dots" role="tablist" aria-label="Listing images">
              {images.map((image, index) => (
                <button
                  key={image + index}
                  className={`carousel-dot ${index === currentIndex ? "active" : ""}`}
                  onClick={() => setCurrentIndex(index)}
                  aria-label={`Show image ${index + 1}`}
                  aria-pressed={index === currentIndex}
                >
                  <span className="sr-only">Image {index + 1}</span>
                </button>
              ))}
            </div>
          )}
        </div>

        <div className="page-info">
          <h1 className="page-title">{listing.title}</h1>

          <div className="info-ring-row">
            <div className="info-column">
              <p className="page-price">${listing.price}</p>

              {listing.condition && (
                <span className="page-condition">{listing.condition}</span>
              )}

              <p className="page-seller">
                ★ {listing.seller} — {listing.feedback}% ({listing.score})
              </p>
            </div>

            <div className="page-rating-ring">
              <RatingRing value={listing.aiScore ?? 0} size={80} />
              <p className="page-rating-label">{listing.aiScore}/100</p>
            </div>
          </div>

          <a
            className="external-ebay-link"
            href={listing.url}
            target="_blank"
            rel="noopener noreferrer"
          >
            View on eBay →
          </a>
        </div>
      </div>

      {/* AI ANALYSIS */}
      <div className="ai-analysis-box">
        <div className="ai-analysis-header">
          <RatingRing value={listing.aiScore ?? 0} size={80} />
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

            {/* CATEGORY RINGS FIRST */}
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

            {/* OVERVIEW TEXT */}
            <h3>Summary</h3>
            <p>{listing.overview}</p>

            {/* DEBUG INFO TOGGLE */}
            <button
              className="ai-debug-toggle"
              onClick={() => setShowDebug(!showDebug)}
            >
              {showDebug ? "Hide debug ↑" : "Show debug info ↓"}
            </button>

            {showDebug && (
              <pre className="debug-block">
                {listing.debugInfo}
              </pre>
            )}

            {/* RAW OUTPUT TOGGLE */}
            <button
              className="ai-debug-toggle"
              onClick={() => setShowRaw(!showRaw)}
            >
              {showRaw ? "Hide raw AI output ↑" : "Show raw AI output ↓"}
            </button>

            {showRaw && (
              <pre className="debug-block">
                {listing.rawAnalysis}
              </pre>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
