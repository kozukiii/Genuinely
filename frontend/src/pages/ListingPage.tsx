import { useLocation } from "react-router-dom";
import type { Listing } from "../types/Listing";
import RatingRing from "../components/RatingRing";
import "./styles/ListingPage.css";
import { useState } from "react";
import { getHighResImage } from "../utils/imageHelpers";



export default function ListingPage() {
  
  const { state } = useLocation();
  const listing = state?.listing as Listing;

  const [showOverview, setShowOverview] = useState(false);
  const highResImage = getHighResImage(listing.image);

  if (!listing) {
    return (
      <p style={{ padding: 20 }}>
        No listing data found. Try navigating from the homepage.
      </p>
    );
  }

  return (
    <div className="listing-page">

      {/* --- TOP SECTION: Card-like compact layout --- */}
      <div className="listing-card-block">

        {/* Left: Product Image */}
        <div className="page-image">
          
          <img src={highResImage} alt={listing.title} />


        </div>

        {/* Right: Info Column */}
        <div className="page-info">

  <h1 className="page-title">{listing.title}</h1>

  {/* LEFT SIDE INFO + RIGHT SIDE RING */}
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
      <RatingRing value={listing.aiScore ?? 0} />
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

      {/* --- AI Overview rewritten into ring-like panel --- */}
      <div className="ai-analysis-box">
        <div className="ai-analysis-header">
          <RatingRing value={listing.aiScore ?? 0} />
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

        {/* Dropdown */}
        {showOverview && (
          <div className="ai-overview-dropdown">
            <p>{listing.overview}</p>
          </div>
        )}
      </div>
    </div>
  );
}
