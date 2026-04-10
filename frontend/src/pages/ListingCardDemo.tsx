import { useEffect, useMemo, useState, type CSSProperties } from "react";
import type { Listing } from "../types/Listing";
import RatingRing from "../components/RatingRing";
import { getHighResImage } from "../utils/imageHelpers";
import { isSaved, toggleSaved } from "../utils/savedListings";
import "./styles/ListingPage.css";

// ─── Helpers ────────────────────────────────────────────────────────────────

function sourceLabel(source?: Listing["source"]) {
  if (source === "marketplace") return "Marketplace";
  return "eBay";
}

function scoreColor(score: number) {
  if (score >= 67) return "#22c55e";
  if (score >= 33) return "#facc15";
  return "#ef4444";
}

const easeInOutQuad = (t: number) => t < 0.5 ? 2 * t * t : -1 + (4 - 2 * t) * t;
const easeOutCubic  = (t: number) => 1 - (1 - t) ** 3;

// ─── Demo data ──────────────────────────────────────────────────────────────

const demoListing: Listing = {
  id: "listingcard-demo",
  source: "marketplace",
  title: "ListingCard Demo",
  price: 295,
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

// ─── Score config ───────────────────────────────────────────────────────────

const FINAL_SCORE = 33;

const FAKE_SCORES: { label: string; value: number }[] = [
  { label: "Price Fairness",     value: 28 },
  { label: "Listing Confidence", value: 55 },
  { label: "Condition Honesty",  value: 71 },
  { label: "Shipping / Pickup",  value: 60 },
  { label: "Listing Quality",    value: 42 },
];

const SUMMARY_TEXT =
  "This listing is priced above the typical range for similar items in this condition. " +
  "The listing itself is of average quality, and while the seller appears credible, " +
  "there are better deals available nearby.";

// ─── Price graph config ─────────────────────────────────────────────────────

const PRICE_LOW  = 180;
const PRICE_HIGH = 320;
const PRICE_EXT  = (PRICE_HIGH - PRICE_LOW) * 0.18;
const BAR_MIN    = PRICE_LOW  - PRICE_EXT;
const BAR_MAX    = PRICE_HIGH + PRICE_EXT;
const BAR_RANGE  = BAR_MAX - BAR_MIN;
const LOW_TICK_PCT   = ((PRICE_LOW  - BAR_MIN) / BAR_RANGE) * 100;
const MID_TICK_PCT   = (((PRICE_LOW + PRICE_HIGH) / 2 - BAR_MIN) / BAR_RANGE) * 100;
const HIGH_TICK_PCT  = ((PRICE_HIGH - BAR_MIN) / BAR_RANGE) * 100;
const PRICE_FILL_PCT = Math.min(Math.max(((demoListing.price! - BAR_MIN) / BAR_RANGE) * 100, 0), 100);

// ─── Animation timing ───────────────────────────────────────────────────────

const LOADING_DURATION_MS        = 3000;
const COMPRESS_DURATION_MS       = 1000;
const COMPRESS_AFTER_TOP_PROGRESS = 0.12;
const COMPRESS_HOLD_MS           = 90;
const FILL_DURATION_MS           = 700;
const FILL_HOLD_MS               = 120;
const FILL_START_SCORE           = 0;

// Fraction of circumference shown as the loading arc (same for all ring sizes)
const LOADING_ARC_FRACTION = 0.32;
// Effective "score" the loading arc represents (used to animate compress-down)
const LOADING_SCORE = LOADING_ARC_FRACTION * 100;

// ─── Ring sizes ─────────────────────────────────────────────────────────────

const MAIN_RING_SIZE = 150;
const SUB_RING_SIZE  = 50;

// ─── Phase type ─────────────────────────────────────────────────────────────

type AnalysisPhase = "idle" | "loading" | "compressing" | "filling" | "done";

// ─── AnimatedRing ────────────────────────────────────────────────────────────
// Single source of truth for ring animation across all ring sizes.
//
// Props:
//   phase           – current analysis phase
//   fillProgress    – 0→1, driven by the filling animation
//   compressProgress – 0→1, driven by the compressing animation
//   targetValue     – final score (0–100) this ring will show
//   size            – rendered pixel size

const HUE_SHIFT_DELAY_MS = 400;

function AnimatedRing({
  phase,
  fillProgress,
  compressProgress,
  targetValue,
  size,
}: {
  phase: AnalysisPhase;
  fillProgress: number;
  compressProgress: number;
  targetValue: number;
  size: number;
}) {
  const [colorReady, setColorReady] = useState(false);

  useEffect(() => {
    if (phase !== "done") { setColorReady(false); return; }
    const t = window.setTimeout(() => setColorReady(true), HUE_SHIFT_DELAY_MS);
    return () => window.clearTimeout(t);
  }, [phase]);
  const center       = size / 2;
  const radius       = size * 0.37;
  const strokeW      = size * 0.10;
  const circumference = 2 * Math.PI * radius;
  const loadingOffset = circumference * (1 - LOADING_ARC_FRACTION);

  // Compress: arc shrinks from LOADING_SCORE → 0
  const compressBlend = Math.min(
    Math.max((compressProgress - COMPRESS_AFTER_TOP_PROGRESS) / (1 - COMPRESS_AFTER_TOP_PROGRESS), 0),
    1,
  );
  const compressScore  = LOADING_SCORE * (1 - compressBlend);
  const compressOffset = circumference - (compressScore / 100) * circumference;

  const fillColor    = scoreColor(targetValue);
  const displayValue = fillProgress * targetValue;

  if (phase === "loading" || phase === "compressing") {
    return (
      <svg
        className={phase === "loading" ? "page-pending-ring--loading" : undefined}
        style={{
          width: size,
          height: size,
          overflow: "visible",
          transformBox: "fill-box",
          transformOrigin: "center",
          flexShrink: 0,
          "--demo-fill-color": fillColor,
          transform: phase === "compressing" ? `rotate(${360 * compressProgress}deg)` : undefined,
        } as CSSProperties}
        width={size}
        height={size}
        viewBox={`0 0 ${size} ${size}`}
      >
        <circle
          className="page-pending-ring__track"
          cx={center} cy={center} r={radius}
          strokeWidth={strokeW} fill="none"
        />
        <circle
          className={`page-pending-ring__arc ${
            phase === "loading" ? "page-pending-ring__arc--loading" : "page-pending-ring__arc--compressing"
          }`}
          cx={center} cy={center} r={radius}
          strokeWidth={strokeW} fill="none" strokeLinecap="round"
          transform={`rotate(-90 ${center} ${center})`}
          style={{
            strokeDasharray: circumference,
            strokeDashoffset: phase === "loading" ? loadingOffset : compressOffset,
          }}
        />
      </svg>
    );
  }

  // filling or done — score ticks up; blue until hue shift delay elapses, then transition to final color
  const ringColor = colorReady ? fillColor : "#3b82f6";
  return <RatingRing value={displayValue} size={size} color={ringColor} />;
}

// ─── Page component ──────────────────────────────────────────────────────────

export default function ListingCardDemo() {
  const [imageIndex,    setImageIndex]    = useState(0);
  const [saved,         setSaved]         = useState(false);
  const [analysisPhase, setAnalysisPhase] = useState<AnalysisPhase>("idle");
  const [analysisScore, setAnalysisScore] = useState<number | null>(null);
  const [compressProgress, setCompressProgress] = useState(0);
  const [fillValue,     setFillValue]     = useState(FILL_START_SCORE);
  const [summaryChars,  setSummaryChars]  = useState(0);

  // Sync saved state
  useEffect(() => {
    setSaved(isSaved(demoListing.id));
    const onChange = () => setSaved(isSaved(demoListing.id));
    window.addEventListener("saved:listings:changed", onChange);
    return () => window.removeEventListener("saved:listings:changed", onChange);
  }, []);

  // Loading → Compressing
  useEffect(() => {
    if (analysisPhase !== "loading") return;
    const t = window.setTimeout(() => {
      setCompressProgress(0);
      setAnalysisPhase("compressing");
    }, LOADING_DURATION_MS);
    return () => window.clearTimeout(t);
  }, [analysisPhase]);

  // Compressing → Filling
  useEffect(() => {
    if (analysisPhase !== "compressing") return;
    let frameId = 0;
    let holdTimeout: number | null = null;
    const start = performance.now();

    const animate = (now: number) => {
      const raw = Math.min((now - start) / COMPRESS_DURATION_MS, 1);
      setCompressProgress(easeInOutQuad(raw));
      if (raw < 1) { frameId = window.requestAnimationFrame(animate); return; }
      holdTimeout = window.setTimeout(() => {
        setFillValue(FILL_START_SCORE);
        setAnalysisPhase("filling");
      }, COMPRESS_HOLD_MS);
    };

    frameId = window.requestAnimationFrame(animate);
    return () => {
      window.cancelAnimationFrame(frameId);
      if (holdTimeout !== null) window.clearTimeout(holdTimeout);
    };
  }, [analysisPhase]);

  // Filling → Done
  useEffect(() => {
    if (analysisPhase !== "filling") return;
    let frameId = 0;
    let holdTimeout: number | null = null;
    const start = performance.now();

    const animate = (now: number) => {
      const raw = Math.min((now - start) / FILL_DURATION_MS, 1);
      setFillValue(FILL_START_SCORE + (FINAL_SCORE - FILL_START_SCORE) * easeOutCubic(raw));
      if (raw < 1) { frameId = window.requestAnimationFrame(animate); return; }
      holdTimeout = window.setTimeout(() => {
        setFillValue(FINAL_SCORE);
        setAnalysisScore(FINAL_SCORE);
        setAnalysisPhase("done");
      }, FILL_HOLD_MS);
    };

    frameId = window.requestAnimationFrame(animate);
    return () => {
      window.cancelAnimationFrame(frameId);
      if (holdTimeout !== null) window.clearTimeout(holdTimeout);
    };
  }, [analysisPhase]);

  // Summary typing effect — starts after a short pause once "done"
  useEffect(() => {
    if (analysisPhase !== "done") { setSummaryChars(0); return; }
    let chars = 0;
    const startDelay = window.setTimeout(() => {
      const interval = window.setInterval(() => {
        chars++;
        setSummaryChars(chars);
        if (chars >= SUMMARY_TEXT.length) window.clearInterval(interval);
      }, 3);
      return () => window.clearInterval(interval);
    }, 600);
    return () => window.clearTimeout(startDelay);
  }, [analysisPhase]);

  // ─── Derived state ───────────────────────────────────────────────────────

  const isAnalyzing = analysisPhase === "loading" || analysisPhase === "compressing" || analysisPhase === "filling";

  // 0→1 progress shared by all rings during the fill animation
  const fillProgress = fillValue / FINAL_SCORE;

  const images = demoListing.images ?? [];
  const safeIndex = Math.min(Math.max(imageIndex, 0), Math.max(images.length - 1, 0));
  const currentImage = getHighResImage(images[safeIndex] ?? "", demoListing.source);

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

  // ─── Render ──────────────────────────────────────────────────────────────

  return (
    <div className="listing-page">
      <div className="listing-card-block" style={{ flexDirection: "column" }}>
        <div style={{ display: "flex", gap: "2.4rem" }}>

          {/* Image panel */}
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
                <button type="button" onClick={() => setImageIndex((i) => (i === 0 ? images.length - 1 : i - 1))}>
                  {"\u2039"}
                </button>
                <span className="image-counter">{safeIndex + 1} / {images.length}</span>
                <button type="button" onClick={() => setImageIndex((i) => (i === images.length - 1 ? 0 : i + 1))}>
                  {"\u203A"}
                </button>
              </div>
            )}
          </div>

          {/* Info panel */}
          <div className="page-info" style={{ position: "relative" }}>
            <div style={{ display: "flex", alignItems: "center", gap: "10px" }}>
              <h1 className="page-title" style={{ margin: 0 }}>{demoListing.title}</h1>
              <button
                type="button"
                className="page-heart-inline"
                aria-pressed={saved}
                aria-label={saved ? "Unsave listing" : "Save listing"}
                onClick={(e) => {
                  e.preventDefault();
                  e.stopPropagation();
                  setSaved(toggleSaved(demoListing));
                }}
              >
                <svg viewBox="0 0 24 24" width="20" height="20" fill={saved ? "currentColor" : "none"} stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                  <path d="M20.84 4.61a5.5 5.5 0 0 0-7.78 0L12 5.67l-1.06-1.06a5.5 5.5 0 0 0-7.78 7.78l1.06 1.06L12 21.23l7.78-7.78 1.06-1.06a5.5 5.5 0 0 0 0-7.78z" />
                </svg>
              </button>
            </div>

            <div className="info-ring-row" style={{ justifyContent: "flex-start", gap: "32px" }}>
              <div className="info-column">
                <div className="price-heart-row" style={{ alignItems: "center" }}>
                  <p className="page-price">{money}</p>
                </div>
                {demoListing.condition && <span className="page-condition">{demoListing.condition}</span>}
                {sellerLine && <p className="page-seller">{sellerLine}</p>}
              </div>

              <div style={{ display: "flex", alignItems: "flex-start", gap: "56px" }}>
                {/* Price graph */}
                {analysisPhase !== "idle" && (
                  <div
                    className={`demo-score-bar-wrap${analysisPhase !== "done" ? " demo-score-bar-wrap--pending" : ""}`}
                    style={{ marginTop: "30px" }}
                  >
                    <div className="demo-score-bar-title">Price Data</div>
                    <div className="demo-score-bar-box">
                      <div className="demo-score-bar-track">
                        {analysisPhase === "done" && (
                          <div className="demo-score-bar-fill demo-fade-in" style={{ left: `${PRICE_FILL_PCT}%` }} />
                        )}
                        <span className="demo-score-tick" style={{ left: `${LOW_TICK_PCT}%` }} />
                        <span className="demo-score-tick" style={{ left: `${MID_TICK_PCT}%`, transform: "translateX(-50%)" }} />
                        <span className="demo-score-tick" style={{ left: `${HIGH_TICK_PCT}%`, transform: "translateX(-100%)" }} />
                        {analysisPhase === "done" && (
                          <div className="demo-score-bar-price-label demo-fade-in" style={{ left: `${PRICE_FILL_PCT}%` }}>
                            <span>Listing Price</span>
                            <span className="demo-price-arrow" />
                          </div>
                        )}
                        <span className="demo-score-label-end" style={{ left: `${LOW_TICK_PCT}%` }}>Low · ${PRICE_LOW}</span>
                        <span className="demo-score-label-end" style={{ left: `${HIGH_TICK_PCT}%` }}>High · ${PRICE_HIGH}</span>
                      </div>
                    </div>
                  </div>
                )}

                {/* Main ring — fixed container prevents layout shifts */}
                {analysisPhase !== "idle" && (
                  <div style={{ position: "relative", width: "150px", height: "190px", flexShrink: 0, left: "28px" }}>
                    <div className="page-rating-ring demo-ring" style={{ position: "absolute", top: 0, left: 0 }}>
                      <AnimatedRing
                        phase={analysisPhase}
                        fillProgress={fillProgress}
                        compressProgress={compressProgress}
                        targetValue={FINAL_SCORE}
                        size={MAIN_RING_SIZE}
                      />
                      {analysisPhase === "done" && analysisScore != null && (
                        <p className="page-rating-label" style={{ position: "absolute", top: "155px", width: "100%", textAlign: "center", margin: 0 }}>
                          {analysisScore}/100
                        </p>
                      )}
                    </div>
                  </div>
                )}
              </div>
            </div>

            {/* Analyze button */}
            <div className="analyze-row" style={{ position: "absolute", left: 0, right: 0, top: "calc(22rem - 92px)" }}>
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
                {isAnalyzing ? "Analyzing\u2026" : analysisScore != null ? "Re-analyze" : "Analyze listing"}
              </button>
            </div>

            <a
              className="external-ebay-link demo-external-link"
              href={demoListing.url}
              target="_blank"
              rel="noopener noreferrer"
            >
              View on {sourceLabel(demoListing.source)} {"\u2192"}
            </a>

            {/* Sub-rings */}
            {analysisPhase !== "idle" && (
              <div className="ai-score-grid" style={{ marginTop: "calc(1rem + 84px)" }}>
                {FAKE_SCORES.map(({ label, value }) => (
                  <div key={label} className="ai-score-item">
                    <AnimatedRing
                      phase={analysisPhase}
                      fillProgress={fillProgress}
                      compressProgress={compressProgress}
                      targetValue={value}
                      size={SUB_RING_SIZE}
                    />
                    <p className="ring-title">{label}</p>
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>

        {/* Summary */}
        {analysisPhase === "done" && analysisScore != null && (
          <div className="ai-overview-dropdown" style={{ borderTop: "none", paddingTop: 0, marginTop: "1rem" }}>
            <h3 className="demo-fade-in">Summary</h3>
            <p>
              {SUMMARY_TEXT.slice(0, summaryChars)}
              {summaryChars < SUMMARY_TEXT.length && <span className="demo-typing-cursor" />}
            </p>
          </div>
        )}
      </div>
    </div>
  );
}
