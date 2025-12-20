import "./styles/ListingCard.css";
import RatingRing from "./RatingRing";
import { Link } from "react-router-dom";
import type { Listing } from "../types/Listing";
import { getHighResImage } from "../utils/imageHelpers";   // ← added

export default function ListingCard({ data }: { data: Listing }) {

  const primaryImage = data.images?.[0];
  const proxiedImage = getHighResImage(primaryImage);

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
            onError={(e) => ((e.currentTarget.src = "/placeholder.jpg"))}
            loading="lazy"
          />
        </div>

        {/* TITLE */}
        <h3 className="listing-title">{data.title}</h3>

        {/* PRICE + CONDITION + SELLER + RATING (2-column flex) */}
        <div className="price-rating">
          <div className="left-side">
            <p className="listing-price">${data.price}</p>

            {data.condition && (
              <span className="listing-condition">{data.condition}</span>
            )}

            {(data.feedback || data.seller) && (
              <p className="listing-feedback">
                ★ {data.seller || "Seller"} — {data.feedback ?? "N/A"}%
              </p>
            )}
          </div>

          {/* RIGHT SIDE: RATING RING */}
          {data.aiScore !== undefined && (
            <div className="rating-ring">
              <RatingRing value={data.aiScore} />
            </div>
          )}
        </div>

        {/* EBAY BUTTON INSIDE CARD */}
        <a
          className="listing-link"
          href={data.url}
          target="_blank"
          rel="noopener noreferrer"
        >
          View on eBay →
        </a>
      </Link>
    </div>
  );
}
