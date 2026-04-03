import "./styles/ListingCard.css";
import RatingRing from "./RatingRing";
import { Link } from "react-router-dom";
import { useEffect, useRef, useState } from "react";
import type { Listing } from "../types/Listing";
import { getHighResImage } from "../utils/imageHelpers";
import { isSaved, toggleSaved } from "../utils/savedListings";

function sourceLabel(source: Listing["source"]) {
  if (source === "marketplace") return "Marketplace";
  return "eBay";
}

export default function ListingCard({ data }: { data: Listing }) {
  const images = data.images ?? [];
  const [imageIndex, setImageIndex] = useState(0);
  const intervalRef = useRef<number | null>(null);
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    setSaved(isSaved(data.id));

    const onChange = () => setSaved(isSaved(data.id));
    window.addEventListener("saved:listings:changed", onChange);
    return () => window.removeEventListener("saved:listings:changed", onChange);
  }, [data.id]);

  function startImageCycle() {
    if (images.length <= 1) return;

    intervalRef.current = window.setInterval(() => {
      setImageIndex((prev) => (prev + 1) % images.length);
    }, 900);
  }

  function stopImageCycle() {
    if (intervalRef.current) {
      clearInterval(intervalRef.current);
      intervalRef.current = null;
    }
    setImageIndex(0);
  }

  const activeImage = images[imageIndex];
  const proxiedImage = getHighResImage(activeImage, data.source);

  const money = new Intl.NumberFormat(undefined, {
    style: "currency",
    currency: data.currency ?? "USD",
    maximumFractionDigits: 0,
  }).format(data.price);

  return (
    <div className="listing-card-wrapper">
      <Link
        to={`/listing/${data.id}`}
        state={{ listing: data }}
        className="listing-card"
      >
        <div
          className="listing-image"
          onMouseEnter={startImageCycle}
          onMouseLeave={stopImageCycle}
        >
          <img
            src={proxiedImage}
            alt={data.title}
            onError={(e) => (e.currentTarget.src = "/placeholder.jpg")}
            loading="lazy"
          />
        </div>

        <h3 className="listing-title">{data.title}</h3>

        <div className="price-rating">
          <div className="left-side">
            <div className="listing-price-row">
              {data.acceptsOffers ? (
                <div className="listing-price-accepts-offers">
                  <p className="listing-price listing-price--offers">Accepts Offers</p>
                  <span className="listing-price--offers-hint">Visit listing to determine price</span>
                </div>
              ) : (
                <p className="listing-price">{money}</p>
              )}
              {data.shippingPrice != null && (
                <span className={`listing-shipping${data.shippingPrice === 0 ? " listing-shipping--free" : ""}`}>
                  {data.shippingPrice === 0
                    ? "Free shipping"
                    : `+ ${new Intl.NumberFormat(undefined, { style: "currency", currency: data.currency ?? "USD", minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(data.shippingPrice)} shipping`}
                </span>
              )}
            </div>

            {data.condition && (
              <span className="listing-condition">{data.condition}</span>
            )}

            {data.source === "marketplace" ? (
              data.location && (
                <p className="listing-feedback">📍 {data.location}</p>
              )
            ) : (
              (data.feedback || data.seller) && (
                <p className="listing-feedback">
                  ★ {data.seller || "Seller"} — {data.feedback ?? "N/A"}%
                </p>
              )
            )}
          </div>

          <div className="card-badges">
            {data.aiScore !== undefined && (
              <div className="badge-ring">
                <RatingRing value={data.aiScore} />
              </div>
            )}

            <button
              type="button"
              className="badge-heart"
              aria-pressed={saved}
              aria-label={saved ? "Unsave listing" : "Save listing"}
              onClick={(e) => {
                e.preventDefault();
                e.stopPropagation();
                const next = toggleSaved(data);
                setSaved(next);
              }}
            >
              {saved ? "♥" : "♡"}
            </button>
          </div>
        </div>

        <button
          type="button"
          className="listing-link"
          onClick={(e) => {
            e.preventDefault();
            e.stopPropagation();
            window.open(data.url, "_blank", "noopener,noreferrer");
          }}
        >
          View on {sourceLabel(data.source)} →
        </button>
      </Link>
    </div>
  );
}