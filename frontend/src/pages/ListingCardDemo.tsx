import { useEffect, useMemo, useState, type CSSProperties } from "react";
import type { Listing } from "../types/Listing";
import RatingRing from "../components/RatingRing";
import { getHighResImage } from "../utils/imageHelpers";
import { isSaved, toggleSaved } from "../utils/savedListings";
import "./styles/ListingPage.css";

function sourceLabel(source?: Listing["source"]) {
  if (source === "marketplace") return "Marketplace";
  return "eBay";
}

function scoreColor(score: number) {
  if (score >= 67) return "#22c55e";
  if (score >= 33) return "#facc15";
  return "#ef4444";
}

const demoListing: Listing = {
  id: "listingcard-demo",
  source: "marketplace",
  title: "ListingCard Demo",
  price: 250,
  currency: "USD",
  condition: "Like New",
  url: "https://www.facebook.com/marketplace/",
  images: [
    "https://placehold.co/900x900/0b1020/f5f5f5?text=ListingCard+Demo+1",
    "https://placehold.co/900x900/101826/f5f5f5?text=ListingCard+Demo+2",
    "https://placehold.co/900x900/162033/f5f5f5?text=ListingCard+Demo+3",
  ],
  location: "Chicago, IL",
};

const FINAL_SCORE = 33;
const LOADING_DURATION_MS = 3000;
const COMPRESS_DURATION_MS = 1000;
const COMPRESS_AFTER_TOP_PROGRESS = 0.12;
const COMPRESS_HOLD_MS = 90;
const FILL_DURATION_MS = 700;
const FILL_HOLD_MS = 120;
const FILL_START_SCORE = 0;
const RING_SIZE = 80;
const RING_CENTER = RING_SIZE / 2;
const RING_RADIUS = RING_SIZE * 0.37;
const RING_STROKE = RING_SIZE * 0.1;
const RING_CIRCUMFERENCE = 2 * Math.PI * RING_RADIUS;
const LOADING_ARC = RING_CIRCUMFERENCE * 0.32;
const LOADING_OFFSET = RING_CIRCUMFERENCE - LOADING_ARC;
const LOADING_SCORE = (LOADING_ARC / RING_CIRCUMFERENCE) * 100;

type AnalysisPhase = "idle" | "loading" | "compressing" | "filling" | "done";

const easeInOutQuad = (t: number) => t < 0.5 ? 2 * t * t : -1 + (4 - 2 * t) * t;
const easeOutCubic = (t: number) => 1 - (1 - t) ** 3;

function ringOffsetForScore(score: number) {
  return RING_CIRCUMFERENCE - (score / 100) * RING_CIRCUMFERENCE;
}

export default function ListingCardDemo() {
  const [imageIndex, setImageIndex] = useState(0);
  const [saved, setSaved] = useState(false);
  const [analysisPhase, setAnalysisPhase] = useState<AnalysisPhase>("idle");
  const [analysisScore, setAnalysisScore] = useState<number | null>(null);
  const [compressProgress, setCompressProgress] = useState(0);
  const [fillValue, setFillValue] = useState(FILL_START_SCORE);

  useEffect(() => {
    setSaved(isSaved(demoListing.id));

    const onChange = () => setSaved(isSaved(demoListing.id));
    window.addEventListener("saved:listings:changed", onChange);
    return () => window.removeEventListener("saved:listings:changed", onChange);
  }, []);

  useEffect(() => {
    if (analysisPhase !== "loading") return;

    const timeout = window.setTimeout(() => {
      setCompressProgress(0);
      setAnalysisPhase("compressing");
    }, LOADING_DURATION_MS);

    return () => window.clearTimeout(timeout);
  }, [analysisPhase]);

  useEffect(() => {
    if (analysisPhase !== "compressing") return;

    let frameId = 0;
    let doneTimeout: number | null = null;
    const start = performance.now();

    const animate = (now: number) => {
      const raw = Math.min((now - start) / COMPRESS_DURATION_MS, 1);
      setCompressProgress(easeInOutQuad(raw));

      if (raw < 1) {
        frameId = window.requestAnimationFrame(animate);
        return;
      }

      doneTimeout = window.setTimeout(() => {
        setFillValue(FILL_START_SCORE);
        setAnalysisPhase("filling");
      }, COMPRESS_HOLD_MS);
    };

    frameId = window.requestAnimationFrame(animate);
    return () => {
      window.cancelAnimationFrame(frameId);
      if (doneTimeout !== null) {
        window.clearTimeout(doneTimeout);
      }
    };
  }, [analysisPhase]);

  useEffect(() => {
    if (analysisPhase !== "filling") return;

    let frameId = 0;
    let doneTimeout: number | null = null;
    const start = performance.now();

    const animate = (now: number) => {
      const raw = Math.min((now - start) / FILL_DURATION_MS, 1);
      const nextValue = FILL_START_SCORE + (FINAL_SCORE - FILL_START_SCORE) * easeOutCubic(raw);
      setFillValue(nextValue);

      if (raw < 1) {
        frameId = window.requestAnimationFrame(animate);
        return;
      }

      doneTimeout = window.setTimeout(() => {
        setFillValue(FINAL_SCORE);
        setAnalysisScore(FINAL_SCORE);
        setAnalysisPhase("done");
      }, FILL_HOLD_MS);
    };

    frameId = window.requestAnimationFrame(animate);
    return () => {
      window.cancelAnimationFrame(frameId);
      if (doneTimeout !== null) {
        window.clearTimeout(doneTimeout);
      }
    };
  }, [analysisPhase]);

  const images = demoListing.images ?? [];
  const safeIndex = Math.min(
    Math.max(imageIndex, 0),
    Math.max(images.length - 1, 0)
  );
  const currentImage = getHighResImage(
    images[safeIndex] ?? "",
    demoListing.source
  );

  const money = useMemo(() => {
    try {
      return new Intl.NumberFormat(undefined, {
        style: "currency",
        currency: demoListing.currency ?? "USD",
        maximumFractionDigits: 0,
      }).format(demoListing.price ?? 0);
    } catch {
      return `$${demoListing.price ?? 0}`;
    }
  }, []);

  const sellerLine = useMemo(() => {
    if (demoListing.source === "marketplace") {
      return demoListing.location ? `\u{1F4CD} ${demoListing.location}` : null;
    }

    return demoListing.seller?.trim() || null;
  }, []);

  const showPendingRing =
    analysisPhase === "loading" || analysisPhase === "compressing";
  const showFillingRing = analysisPhase === "filling";
  const isAnalyzing =
    analysisPhase === "loading"
    || analysisPhase === "compressing"
    || analysisPhase === "filling";
  const finalRingColor = scoreColor(FINAL_SCORE);
  const fillRingStyle = {
    "--demo-fill-color": finalRingColor,
  } as CSSProperties;
  const compressBlend = Math.min(
    Math.max(
      (compressProgress - COMPRESS_AFTER_TOP_PROGRESS)
        / (1 - COMPRESS_AFTER_TOP_PROGRESS),
      0
    ),
    1
  );
  const compressScore =
    LOADING_SCORE + (FILL_START_SCORE - LOADING_SCORE) * compressBlend;
  const compressRingStyle = {
    transform: `rotate(${360 * compressProgress}deg)`,
    "--demo-fill-color": finalRingColor,
  } as CSSProperties;

  return (
    <div className="listing-page">
      <div className="listing-card-block">
        <div className="page-image">
          <div className="image-frame">
            <img
              src={currentImage || "/placeholder.jpg"}
              alt={demoListing.title}
              onError={(e) => (e.currentTarget.src = "/placeholder.jpg")}
            />
          </div>

          {images.length > 1 && (
            <div className="image-nav">
              <button
                type="button"
                onClick={() =>
                  setImageIndex((i) => (i === 0 ? images.length - 1 : i - 1))
                }
              >
                {"\u2039"}
              </button>

              <span className="image-counter">
                {safeIndex + 1} / {images.length}
              </span>

              <button
                type="button"
                onClick={() =>
                  setImageIndex((i) => (i === images.length - 1 ? 0 : i + 1))
                }
              >
                {"\u203A"}
              </button>
            </div>
          )}
        </div>

        <div className="page-info">
          <h1 className="page-title">{demoListing.title}</h1>

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
                    const next = toggleSaved(demoListing);
                    setSaved(next);
                  }}
                >
                  {saved ? "\u2665" : "\u2661"}
                </button>
              </div>

              {demoListing.condition && (
                <span className="page-condition">{demoListing.condition}</span>
              )}

              {sellerLine && <p className="page-seller">{sellerLine}</p>}
            </div>

            {showPendingRing && (
              <div className="page-rating-ring" aria-label="Analysis loading">
                <svg
                  className={`page-pending-ring ${
                    analysisPhase === "loading"
                      ? "page-pending-ring--loading"
                      : "page-pending-ring--compressing"
                  }`}
                  style={analysisPhase === "compressing" ? compressRingStyle : undefined}
                  width={RING_SIZE}
                  height={RING_SIZE}
                  viewBox={`0 0 ${RING_SIZE} ${RING_SIZE}`}
                >
                  <circle
                    className="page-pending-ring__track"
                    cx={RING_CENTER}
                    cy={RING_CENTER}
                    r={RING_RADIUS}
                    strokeWidth={RING_STROKE}
                    fill="none"
                  />
                  <circle
                    className={`page-pending-ring__arc ${
                      analysisPhase === "loading"
                        ? "page-pending-ring__arc--loading"
                        : "page-pending-ring__arc--compressing"
                    }`}
                    cx={RING_CENTER}
                    cy={RING_CENTER}
                    r={RING_RADIUS}
                    strokeWidth={RING_STROKE}
                    fill="none"
                    strokeLinecap="round"
                    transform={`rotate(-90 ${RING_CENTER} ${RING_CENTER})`}
                    style={{
                      strokeDasharray: `${RING_CIRCUMFERENCE}`,
                      strokeDashoffset:
                        analysisPhase === "loading"
                          ? LOADING_OFFSET
                          : ringOffsetForScore(compressScore),
                    }}
                  />
                </svg>
              </div>
            )}

            {showFillingRing && (
              <div
                className="page-rating-ring page-rating-ring--filling"
                style={fillRingStyle}
                aria-label="Analysis filling"
              >
                <RatingRing value={fillValue} size={80} />
              </div>
            )}

            {analysisPhase === "done" && analysisScore != null && (
              <div className="page-rating-ring">
                <RatingRing value={analysisScore} size={80} />
                <p className="page-rating-label">{analysisScore}/100</p>
              </div>
            )}
          </div>

          <div className="analyze-row">
            <button
              type="button"
              className="analyze-btn"
              onClick={() => {
                setAnalysisScore(null);
                setCompressProgress(0);
                setFillValue(FILL_START_SCORE);
                setAnalysisPhase("loading");
              }}
              disabled={isAnalyzing}
            >
              {isAnalyzing
                ? "Analyzing\u2026"
                : analysisScore != null
                ? "Re-analyze"
                : "Analyze listing"}
            </button>
          </div>

          <a
            className="external-ebay-link"
            href={demoListing.url}
            target="_blank"
            rel="noopener noreferrer"
          >
            View on {sourceLabel(demoListing.source)} {"\u2192"}
          </a>
        </div>
      </div>
    </div>
  );
}
