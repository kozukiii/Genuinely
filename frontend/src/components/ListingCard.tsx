import "./styles/ListingCard.css";
import RatingRing from "./RatingRing";
import { Link } from "react-router-dom";
import type { Listing } from "../types/Listing";
import { getHighResImage } from "../utils/imageHelpers";

function sourceLabel(source: Listing["source"]) {
  if (source === "marketplace") return "Marketplace";
  return "eBay";
}

export default function ListingCard({ data }: { data: Listing }) {
  const primaryImage = data.images?.[0];
  const proxiedImage = getHighResImage(primaryImage);

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
        <div className="listing-image">
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

          {data.aiScore !== undefined && (
            <div className="rating-ring">
              <RatingRing value={data.aiScore} />
            </div>
          )}
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
