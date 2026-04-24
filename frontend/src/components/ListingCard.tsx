import "./styles/ListingCard.css";
import RatingRing from "./RatingRing";
import { Link } from "react-router-dom";
import { useEffect, useRef, useState } from "react";
import type { Listing } from "../types/Listing";
import { getHighResImage } from "../utils/imageHelpers";
import { isSaved, toggleSaved } from "../utils/savedListings";

function formatDeliveryType(type: string): string {
  return type.replace(/_/g, " ").toLowerCase().replace(/\b\w/g, (c) => c.toUpperCase());
}

function abbreviateCondition(condition: string): string {
  const c = condition.toLowerCase();
  if (c.includes("certified") && c.includes("refurb")) return "Cert. Refurbished";
  if (c.includes("seller") && c.includes("refurb")) return "Refurbished";
  if (c.includes("manufacturer") && c.includes("refurb")) return "Mfr. Refurbished";
  if (c.includes("refurb")) return "Refurbished";
  if (c.includes("like new") || c.includes("like-new")) return "Like New";
  if (c.includes("open box")) return "Open Box";
  if (c.includes("very good")) return "Very Good";
  return condition;
}

function sourceLabel(source: Listing["source"]) {
  if (source === "marketplace") return "Marketplace";
  return "eBay";
}

const STAR_DATA = [
  { left: -9,    top: -8,     size: 7, delay: "0s"    },
  { right: -8,   top: -7,     size: 6, delay: "0.6s"  },
  { left: -7,    bottom: -7,  size: 5, delay: "1.1s"  },
  { right: -7,   bottom: -6,  size: 7, delay: "0.35s" },
  { left: "35%", top: -10,    size: 5, delay: "0.85s" },
  { left: "60%", bottom: -9,  size: 6, delay: "0.5s"  },
  { right: -12,  top: "40%",  size: 5, delay: "1.4s"  },
  { left: -12,   top: "45%",  size: 4, delay: "0.2s"  },
  { left: "20%", top: -8,     size: 4, delay: "1.7s"  },
  { right: -6,   bottom: -11, size: 5, delay: "0.9s"  },
  { left: "50%", bottom: -12, size: 6, delay: "1.3s"  },
  { right: -14,  top: "20%",  size: 4, delay: "0.75s" },
  { left: -14,   top: "20%",  size: 5, delay: "1.55s" },
  { left: "75%", top: -9,     size: 4, delay: "0.15s" },
  { right: -10,  bottom: -10, size: 6, delay: "1.8s"  },
] as const;

function StarSparkles() {
  return (
    <>
      {STAR_DATA.map((s, i) => (
        <svg
          key={i}
          viewBox="0 0 10 10"
          aria-hidden="true"
          style={{
            position: "absolute",
            width: (s as any).size,
            height: (s as any).size,
            ...(typeof (s as any).left   !== "undefined" && { left:   (s as any).left   }),
            ...(typeof (s as any).right  !== "undefined" && { right:  (s as any).right  }),
            ...(typeof (s as any).top    !== "undefined" && { top:    (s as any).top    }),
            ...(typeof (s as any).bottom !== "undefined" && { bottom: (s as any).bottom }),
            animation: `starTwinkle 2s ease-in-out ${(s as any).delay} infinite`,
            pointerEvents: "none",
          }}
        >
          <path d="M5 0 L5.5 4.5 L10 5 L5.5 5.5 L5 10 L4.5 5.5 L0 5 L4.5 4.5 Z" fill="#a855f7" />
        </svg>
      ))}
    </>
  );
}

const FAIR_STAR_DATA = [
  { left: -7,    top: -6,    size: 4, delay: "0s"    },
  { right: -7,   bottom: -6, size: 5, delay: "0.8s"  },
  { left: "50%", top: -8,    size: 4, delay: "1.3s"  },
  { left: -9,    bottom: -7, size: 4, delay: "0.45s" },
  { right: -8,   top: -7,    size: 4, delay: "1.6s"  },
] as const;

function FairStarSparkles() {
  return (
    <>
      {FAIR_STAR_DATA.map((s, i) => (
        <svg key={i} viewBox="0 0 10 10" aria-hidden="true" style={{ position: "absolute", width: (s as any).size, height: (s as any).size, ...(typeof (s as any).left !== "undefined" && { left: (s as any).left }), ...(typeof (s as any).right !== "undefined" && { right: (s as any).right }), ...(typeof (s as any).top !== "undefined" && { top: (s as any).top }), ...(typeof (s as any).bottom !== "undefined" && { bottom: (s as any).bottom }), animation: `starTwinkle 2s ease-in-out ${(s as any).delay} infinite`, pointerEvents: "none" }}>
          <path d="M5 0 L5.5 4.5 L10 5 L5.5 5.5 L5 10 L4.5 5.5 L0 5 L4.5 4.5 Z" fill="#facc15" />
        </svg>
      ))}
    </>
  );
}

const GOOD_STAR_DATA = [
  { left: -8,    top: -7,    size: 5, delay: "0s"    },
  { right: -7,   top: -6,    size: 4, delay: "0.7s"  },
  { right: -6,   bottom: -7, size: 5, delay: "1.2s"  },
  { left: "40%", top: -8,    size: 4, delay: "0.4s"  },
  { left: -10,   bottom: -6, size: 4, delay: "1.0s"  },
  { left: "65%", bottom: -8, size: 5, delay: "0.55s" },
] as const;

function GoodStarSparkles() {
  return (
    <>
      {GOOD_STAR_DATA.map((s, i) => (
        <svg key={i} viewBox="0 0 10 10" aria-hidden="true" style={{ position: "absolute", width: (s as any).size, height: (s as any).size, ...(typeof (s as any).left !== "undefined" && { left: (s as any).left }), ...(typeof (s as any).right !== "undefined" && { right: (s as any).right }), ...(typeof (s as any).top !== "undefined" && { top: (s as any).top }), ...(typeof (s as any).bottom !== "undefined" && { bottom: (s as any).bottom }), animation: `starTwinkle 2s ease-in-out ${(s as any).delay} infinite`, pointerEvents: "none" }}>
          <path d="M5 0 L5.5 4.5 L10 5 L5.5 5.5 L5 10 L4.5 5.5 L0 5 L4.5 4.5 Z" fill="#22c55e" />
        </svg>
      ))}
    </>
  );
}

function getPriceBadge(price: number, priceLow: number, priceHigh: number) {
  const mid = (priceLow + priceHigh) / 2;
  if (price < priceLow * 0.5) return { label: "RISKY PRICE",  color: "#ef4444" };
  if (price < priceLow)       return { label: "GREAT PRICE",  color: "#a855f7" };
  if (price <= mid)           return { label: "GOOD PRICE",   color: "#22c55e" };
  if (price <= priceHigh)     return { label: "FAIR PRICE",   color: "#facc15" };
  return                             { label: "HIGH PRICE",   color: "#ef4444" };
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

  const money = data.price != null
    ? new Intl.NumberFormat(undefined, {
        style: "currency",
        currency: data.currency ?? "USD",
        maximumFractionDigits: 0,
      }).format(data.price)
    : null;
  const showPendingMarketplacePrice = data.source === "marketplace"
    && data.analysisPending
    && data.acceptsOffers !== true
    && data.price === 0;

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

        <div className="listing-title-row">
          <h3 className="listing-title">{data.title}</h3>
          <button
            type="button"
            className="badge-heart"
            aria-pressed={saved}
            aria-label={saved ? "Unsave listing" : "Save listing"}
            onClick={(e) => {
              e.preventDefault();
              e.stopPropagation();
              setSaved(toggleSaved(data));
            }}
          >
            <svg viewBox="0 0 24 24" width="18" height="18" fill={saved ? "currentColor" : "none"} stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
              <path d="M20.84 4.61a5.5 5.5 0 0 0-7.78 0L12 5.67l-1.06-1.06a5.5 5.5 0 0 0-7.78 7.78l1.06 1.06L12 21.23l7.78-7.78 1.06-1.06a5.5 5.5 0 0 0 0-7.78z" />
            </svg>
          </button>
        </div>

        <div className="price-rating">
          <div className="left-side">
            {data.price != null && data.priceLow != null && data.priceHigh != null && (() => {
              const badge = getPriceBadge(data.price, data.priceLow, data.priceHigh);
              return (
                <span className="listing-price-badge" style={{ color: badge.color, borderColor: `${badge.color}55`, position: "relative", overflow: "visible" }}>
                  {badge.label === "GREAT PRICE" && <StarSparkles />}
                  {badge.label === "GOOD PRICE" && <GoodStarSparkles />}
                  {badge.label === "FAIR PRICE" && <FairStarSparkles />}
                  {badge.label}
                </span>
              );
            })()}
            <div className="listing-price-row">
              {showPendingMarketplacePrice ? (
                <div className="listing-price-accepts-offers">
                  <p className="listing-price listing-price--offers">Loading price…</p>
                  <span className="listing-price--offers-hint">Fetching seller-entered amount</span>
                </div>
              ) : data.acceptsOffers ? (
                <div className="listing-price-accepts-offers">
                  <p className="listing-price listing-price--offers">Accepts Offers</p>
                  <span className="listing-price--offers-hint">View listing for more info</span>
                </div>
              ) : money != null ? (
                <p className="listing-price">{money}</p>
              ) : null}
              {data.shippingPrice != null ? (
                <span className={`listing-shipping${data.shippingPrice === 0 ? " listing-shipping--free" : ""}`}>
                  {data.shippingPrice === 0
                    ? "Free shipping"
                    : `${data.shippingEstimated ? "~" : "+ "}${new Intl.NumberFormat(undefined, { style: "currency", currency: data.currency ?? "USD", minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(data.shippingPrice)} shipping${data.shippingEstimated ? " (est.)" : ""}`}
                </span>
              ) : data.shippingCalculated ? (
                <span className="listing-shipping">Calculated shipping</span>
              ) : null}
            </div>

            {data.condition && (
              <span className="listing-condition">{abbreviateCondition(data.condition)}</span>
            )}

            {data.source === "marketplace" ? (
              <>
                {(data.location || (Array.isArray(data.delivery_types) && data.delivery_types.length > 0)) && (
                  <div className="listing-location-row">
                    {data.location && <span className="listing-location">📍 {data.location}</span>}
                    {Array.isArray(data.delivery_types) && (
                      data.delivery_types.length > 1
                        ? <span className="listing-delivery-badge">{data.delivery_types.length} shipping/pickup options</span>
                        : data.delivery_types.map((type) => (
                            <span key={type} className="listing-delivery-badge">
                              {formatDeliveryType(type)}
                            </span>
                          ))
                    )}
                  </div>
                )}
              </>
            ) : (
              (data.feedback || data.seller) && (
                <p className="listing-seller-line">
                  <span className="listing-seller-name">{data.seller || "Seller"}</span>
                  <span className="listing-seller-feedback"> — {data.feedback ?? "N/A"}%</span>
                </p>
              )
            )}
          </div>

        </div>

        <div className="card-badges">
          {data.aiScore !== undefined ? (
            <div className="badge-ring">
              <RatingRing value={data.aiScore} />
            </div>
          ) : data.analysisPending ? (
            <div className="badge-ring">
              <svg className="ring-pending" width="75" height="75" viewBox="0 0 50 50">
                <circle cx="25" cy="25" r="18.5" stroke="#374151" strokeWidth="5" fill="none" />
                <circle
                  cx="25" cy="25" r="18.5"
                  stroke="rgba(77,166,255,0.6)"
                  strokeWidth="5"
                  fill="none"
                  strokeDasharray="29 87"
                  strokeLinecap="round"
                  transform="rotate(-90 25 25)"
                />
              </svg>
            </div>
          ) : null}
        </div>

        <div className="listing-bottom">
          {Array.isArray(data.highlights) && data.highlights.length > 0 && (
            <div className="listing-highlights">
              {data.highlights.slice(0, 2).map((h, i) => (
                <span key={i} className={`listing-highlight-badge listing-highlight-badge--${h.positive ? "pos" : "neg"}`}>
                  {h.positive ? "+ " : "− "}{h.label}
                </span>
              ))}
            </div>
          )}

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
        </div>
      </Link>
    </div>
  );
}
