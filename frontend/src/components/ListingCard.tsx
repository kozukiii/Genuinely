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
    // initialize saved status
    setSaved(isSaved(data.id));

    // keep in sync if saved changes elsewhere
    const onChange = () => setSaved(isSaved(data.id));
    window.addEventListener("saved:listings:changed", onChange);
    return () => window.removeEventListener("saved:listings:changed", onChange);
  }, [data.id]);

  function startImageCycle() {
    if (images.length <= 1) return;

    intervalRef.current = window.setInterval(() => {
      setImageIndex((prev) => (prev + 1) % images.length);
    }, 900); // slow + premium feel
  }

  function stopImageCycle() {
    if (intervalRef.current) {
      clearInterval(intervalRef.current);
      intervalRef.current = null;
    }
    setImageIndex(0);
  }

  const activeImage = images[imageIndex];
  const proxiedImage = getHighResImage(activeImage);

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
        {/* IMAGE */}
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

        {/* TITLE */}
        <h3 className="listing-title">{data.title}</h3>

        {/* PRICE + CONDITION + SELLER + RATING */}
        <div className="price-rating">
          <div className="left-side">
            <p className="listing-price">{money}</p>

            {data.condition && (
              <span className="listing-condition">{data.condition}</span>
            )}

            {(data.feedback || data.seller) && (
              <p className="listing-feedback">
                ★ {data.seller || "Seller"} — {data.feedback ?? "N/A"}%
              </p>
            )}
          </div>

                  {/* FIXED BADGES: ring + heart */}
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

        {/* SOURCE BUTTON */}
        <button
          type="button"
          className="listing-link"
          onClick={(e) => {
            e.preventDefault(); // prevents Link navigation
            e.stopPropagation(); // prevents click bubbling to the card Link
            window.open(data.url, "_blank", "noopener,noreferrer");
          }}
        >
          View on {sourceLabel(data.source)} →
        </button>
      </Link>
    </div>
  );
}
