import "./styles/ListingCard.css";

export default function SkeletonCard() {
  return (
    <div className="listing-card-wrapper">
      <div className="listing-card listing-card--skeleton">
        <div className="skeleton-image" />
        <div className="skeleton-title" />
        <div className="skeleton-title skeleton-title--short" />
        <div className="price-rating">
          <div className="left-side">
            <div className="skeleton-price" />
            <div className="skeleton-pill" />
            <div className="skeleton-pill skeleton-pill--wide" />
          </div>
          <div className="card-badges">
            <div className="badge-ring">
              <div className="skeleton-ring" />
            </div>
            <div className="skeleton-heart" />
          </div>
        </div>
        <div className="skeleton-button" />
      </div>
    </div>
  );
}
