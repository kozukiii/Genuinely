import { useLocation, useNavigate } from "react-router-dom";
import { Helmet } from "react-helmet-async";
import { useAuth } from "../context/AuthContext";
import type { Listing } from "../types/Listing";
import RatingRing from "../components/RatingRing";
import ListingCard from "../components/ListingCard";
import "./styles/ListingPage.css";
import { useEffect, useMemo, useRef, useState, type CSSProperties } from "react";
import { getHighResImage } from "../utils/imageHelpers";
import { isSaved, toggleSaved, updateSavedListing } from "../utils/savedListings";
import { recordView, updateRecentlyViewed } from "../utils/recentlyViewed";
import { subscribeToAnalysis } from "../utils/analysisStore";

function sourceLabel(source?: Listing["source"]) {
  if (source === "marketplace") return "Marketplace";
  return "eBay";
}

function formatDeliveryType(type: string): string {
  return type.replace(/_/g, " ").toLowerCase().replace(/\b\w/g, (c) => c.toUpperCase());
}

function looksLikeDebugPayload(value?: string | null) {
  if (!value) return false;
  const trimmed = value.trim();
  if (!trimmed) return false;
  return /DEBUG INFO:/i.test(trimmed)
    || (/^\s*[[{]/.test(trimmed) && /"scores"\s*:/.test(trimmed));
}

function sanitizeVisibleText(value?: string | null) {
  if (!value) return null;
  const trimmed = value.trim();
  if (!trimmed) return null;
  if (looksLikeDebugPayload(trimmed)) return null;
  const withoutComments = trimmed.replace(/<!--[\s\S]*?-->/g, " ");
  const withoutStyleAndScript = withoutComments
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<script[\s\S]*?<\/script>/gi, " ");
  const withoutTags = withoutStyleAndScript.replace(/<[^>]+>/g, " ");
  const decoded = withoutTags
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&quot;/gi, "\"")
    .replace(/&#39;/gi, "'")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">");
  const normalized = decoded.replace(/\s+/g, " ").trim();
  if (!normalized) return null;
  return normalized;
}

const API_BASE = import.meta.env.VITE_API_BASE_URL ?? "";
const SEARCH_LISTINGS_KEY = "search:listings";

function buildPriceBarProps(priceLow: number, priceHigh: number, listingPrice: number | null) {
  const ext      = (priceHigh - priceLow) * 0.18;
  const barMin   = priceLow  - ext;
  const barMax   = priceHigh + ext;
  const barRange = barMax - barMin;
  const lowPct   = ((priceLow  - barMin) / barRange) * 100;
  const midPct   = (((priceLow + priceHigh) / 2 - barMin) / barRange) * 100;
  const highPct  = ((priceHigh - barMin) / barRange) * 100;
  const fillPct  = listingPrice != null
    ? Math.min(Math.max(((listingPrice - barMin) / barRange) * 100, 0), 100)
    : null;
  return { lowPct, midPct, highPct, fillPct };
}

// ─── Animation ───────────────────────────────────────────────────────────────

const COMPRESS_DURATION_MS        = 1000;
const COMPRESS_AFTER_TOP_PROGRESS = 0.12;
const COMPRESS_HOLD_MS            = 90;
const FILL_DURATION_MS            = 700;
const FILL_HOLD_MS                = 120;
const LOADING_ARC_FRACTION        = 0.32;
const LOADING_SCORE               = LOADING_ARC_FRACTION * 100;
const HUE_SHIFT_DELAY_MS          = 400;
const LOADING_PERIOD_MS           = 1200; // must match CSS animation duration

const easeInOutQuad = (t: number) => t < 0.5 ? 2 * t * t : -1 + (4 - 2 * t) * t;
const easeOutCubic  = (t: number) => 1 - (1 - t) ** 3;

function scoreColor(score: number) {
  if (score >= 67) return "#22c55e";
  if (score >= 33) return "#facc15";
  return "#ef4444";
}

function getPriceBadge(price: number, priceLow: number, priceHigh: number): { label: string; color: string; bg: string } {
  const mid = (priceLow + priceHigh) / 2;
  if (price < priceLow * 0.5)  return { label: "RISKY PRICE", color: "#ef4444", bg: "rgba(239,68,68,0.08)" };
  if (price < priceLow)        return { label: "GREAT PRICE", color: "#a855f7", bg: "rgba(168,85,247,0.08)" };
  if (price <= mid)             return { label: "GOOD PRICE",  color: "#22c55e", bg: "rgba(34,197,94,0.08)" };
  if (price <= priceHigh)       return { label: "FAIR PRICE",  color: "#facc15", bg: "rgba(250,204,21,0.08)" };
  return                               { label: "HIGH PRICE",  color: "#ef4444", bg: "rgba(239,68,68,0.08)" };
}

const STAR_DATA = [
  { left: -9,  top: -8,    size: 7, delay: "0s"     },
  { right: -8, top: -7,    size: 6, delay: "0.6s"   },
  { left: -7,  bottom: -7, size: 5, delay: "1.1s"   },
  { right: -7, bottom: -6, size: 7, delay: "0.35s"  },
  { left: "35%", top: -10, size: 5, delay: "0.85s"  },
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
            width: s.size,
            height: s.size,
            ...(typeof (s as any).left   !== "undefined" && { left:   (s as any).left   }),
            ...(typeof (s as any).right  !== "undefined" && { right:  (s as any).right  }),
            ...(typeof (s as any).top    !== "undefined" && { top:    (s as any).top    }),
            ...(typeof (s as any).bottom !== "undefined" && { bottom: (s as any).bottom }),
            animation: `starTwinkle 2s ease-in-out ${s.delay} infinite`,
            pointerEvents: "none",
          }}
        >
          <path d="M5 0 L5.5 4.5 L10 5 L5.5 5.5 L5 10 L4.5 5.5 L0 5 L4.5 4.5 Z" fill="#a855f7" />
        </svg>
      ))}
    </>
  );
}

type AnalysisPhase = "idle" | "loading" | "compressing" | "filling" | "done";

function AnimatedRing({
  phase, fillProgress, compressProgress, compressStartFrac, targetValue, size,
}: {
  phase: AnalysisPhase;
  fillProgress: number;
  compressProgress: number;
  compressStartFrac: number;
  targetValue: number;
  size: number;
}) {
  const [colorReady, setColorReady] = useState(false);

  useEffect(() => {
    if (phase !== "done") { setColorReady(false); return; }
    const t = window.setTimeout(() => setColorReady(true), HUE_SHIFT_DELAY_MS);
    return () => window.clearTimeout(t);
  }, [phase]);

  const center        = size / 2;
  const radius        = size * 0.37;
  const strokeW       = size * 0.10;
  const circumference = 2 * Math.PI * radius;
  const loadingOffset = circumference * (1 - LOADING_ARC_FRACTION);

  const compressBlend  = Math.min(
    Math.max((compressProgress - COMPRESS_AFTER_TOP_PROGRESS) / (1 - COMPRESS_AFTER_TOP_PROGRESS), 0), 1,
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
          width: size, height: size,
          overflow: "visible",
          transformBox: "fill-box",
          transformOrigin: "center",
          flexShrink: 0,
          "--demo-fill-color": fillColor,
          transform: phase === "compressing" ? `rotate(${(compressStartFrac + compressProgress * (1 - compressStartFrac)) * 360}deg)` : undefined,
        } as CSSProperties}
        width={size} height={size}
        viewBox={`0 0 ${size} ${size}`}
      >
        <circle className="page-pending-ring__track"
          cx={center} cy={center} r={radius} strokeWidth={strokeW} fill="none" />
        <circle
          className={`page-pending-ring__arc ${
            phase === "loading" ? "page-pending-ring__arc--loading" : "page-pending-ring__arc--compressing"
          }`}
          cx={center} cy={center} r={radius}
          strokeWidth={strokeW} fill="none" strokeLinecap="round"
          transform={`rotate(-90 ${center} ${center})`}
          style={{ strokeDasharray: circumference, strokeDashoffset: phase === "loading" ? loadingOffset : compressOffset }}
        />
      </svg>
    );
  }

  const ringColor = colorReady ? fillColor : "#3b82f6";
  return <RatingRing value={displayValue} size={size} color={ringColor} />;
}

// ─── Page ─────────────────────────────────────────────────────────────────────

export default function ListingPage() {
  const { state } = useLocation();
  const navigate = useNavigate();
  const listing = (state as { listing?: Listing } | null)?.listing;

  const { user } = useAuth();
  const isAdmin = user?.isAdmin === true;

  const [showDebug,   setShowDebug]   = useState(false);
  const [showRaw,     setShowRaw]     = useState(false);
  const [showContext, setShowContext] = useState(false);
  const [showPrompt,  setShowPrompt]  = useState(false);
  const [activeTab,   setActiveTab]   = useState<"overview" | "details">("overview");
  const [imageIndex,  setImageIndex]  = useState(0);
  const [viewerOpen,  setViewerOpen]  = useState(false);
  const [saved,       setSaved]       = useState(false);
  const [enrichedImages,  setEnrichedImages]  = useState<string[] | null>(null);
  const [enrichLoading,   setEnrichLoading]   = useState(false);
  const [analysisResult,  setAnalysisResult]  = useState<Partial<Listing> & { analyzedAt?: string } | null>(
    listing?.aiScore != null ? { ...listing, analyzedAt: undefined } : null
  );
  const [analyzing,    setAnalyzing]   = useState(false);
  const [analyzeError, setAnalyzeError] = useState<string | null>(null);
  const [fetchedSimilar, setFetchedSimilar] = useState<Listing[]>([]);

  // ── Animation state ───────────────────────────────────────────────────────
  const hasInitialScore = listing?.aiScore != null;
  const isPendingFromSearch = !hasInitialScore && listing?.analysisPending === true;
  const [analysisPhase,    setAnalysisPhase]    = useState<AnalysisPhase>(
    hasInitialScore ? "filling" : isPendingFromSearch ? "loading" : "idle"
  );
  const [compressProgress,  setCompressProgress]  = useState(0);
  const [compressStartFrac, setCompressStartFrac] = useState(0);
  const [fillValue,         setFillValue]         = useState(0);
  const targetScoreRef  = useRef<number>(listing?.aiScore ?? 0);
  const loadingStartRef = useRef<number>(0);

  // ── Track loading phase start time for smooth compressing handoff ────────
  useEffect(() => {
    if (analysisPhase === "loading") loadingStartRef.current = performance.now();
  }, [analysisPhase]);

  // ── Save / view tracking ──────────────────────────────────────────────────
  useEffect(() => {
    if (!listing?.id) return;
    recordView(listing);
    setSaved(isSaved(listing.id));
    const onChange = () => setSaved(isSaved(listing.id));
    window.addEventListener("saved:listings:changed", onChange);
    return () => window.removeEventListener("saved:listings:changed", onChange);
  }, [listing?.id, listing]);

  // ── Marketplace image enrichment ──────────────────────────────────────────
  useEffect(() => {
    if (listing?.source !== "marketplace" || !listing?.id) return;
    setEnrichLoading(true);
    fetch(`${API_BASE}/api/marketplace/item/${listing.id}`)
      .then((r) => { if (!r.ok) throw new Error(`HTTP ${r.status}`); return r.json(); })
      .then((data) => {
        if (Array.isArray(data.images) && data.images.length > 0) setEnrichedImages(data.images);
      })
      .catch((err) => console.warn("Marketplace enrichment failed:", err))
      .finally(() => setEnrichLoading(false));
  }, [listing?.id, listing?.source]);

  // ── Similar listings fetch ────────────────────────────────────────────────
  useEffect(() => {
    if (!listing?.title) return;
    const raw = sessionStorage.getItem(SEARCH_LISTINGS_KEY);
    if (raw) return;
    const stopWords = new Set(["the", "a", "an", "and", "or", "for", "of", "in", "with", "lot", "set"]);
    const words = listing.title
      .toLowerCase()
      .replace(/[^a-z0-9 ]/g, " ")
      .split(/\s+/)
      .filter((w) => w.length > 3 && !stopWords.has(w));
    const keyword = words.slice(0, 2).join(" ");
    if (!keyword) return;
    fetch(`${API_BASE}/api/search?query=${encodeURIComponent(keyword)}&limit=8&sources=${listing.source}&analyze=0`)
      .then((r) => r.json())
      .then((data: Listing[]) => {
        if (!Array.isArray(data)) return;
        setFetchedSimilar(
          data.filter((item) => !(item.id === listing.id && item.source === listing.source)).slice(0, 4)
        );
      })
      .catch(() => {});
  }, [listing?.id, listing?.source, listing?.title]);

  // ── Subscribe to background analysis score (when card was pending on load) ──
  useEffect(() => {
    if (!listing || !listing.analysisPending || listing.aiScore != null) return;
    const unsub = subscribeToAnalysis(listing, (scored) => {
      if (!scored) {
        // Pipeline failed — let the user trigger analysis manually
        setAnalysisPhase("idle");
        return;
      }
      targetScoreRef.current = scored.aiScore ?? 0;
      setAnalysisResult({ ...scored, analysisPending: false });
      updateSavedListing(scored);
      updateRecentlyViewed(scored);
      navigate(".", { replace: true, state: { listing: { ...scored, analysisPending: false } } });
      setCompressStartFrac((performance.now() - loadingStartRef.current) % LOADING_PERIOD_MS / LOADING_PERIOD_MS);
      setCompressProgress(0);
      setFillValue(0);
      setAnalysisPhase("compressing");
    });
    return unsub;
  // listing identity is stable for the lifetime of this page instance
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [listing?.id, listing?.source]);

  // ── Image viewer keyboard nav ─────────────────────────────────────────────
  useEffect(() => {
    if (!viewerOpen) return;
    const imgCount = (enrichedImages !== null && enrichedImages.length > 0
      ? enrichedImages : listing?.images ?? []).length;
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape")      setViewerOpen(false);
      if (e.key === "ArrowRight")  setImageIndex((i) => (i === imgCount - 1 ? 0 : i + 1));
      if (e.key === "ArrowLeft")   setImageIndex((i) => (i === 0 ? imgCount - 1 : i - 1));
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [viewerOpen, enrichedImages, listing?.images]);

  // ── Compressing → Filling ─────────────────────────────────────────────────
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
        setFillValue(0);
        setAnalysisPhase("filling");
      }, COMPRESS_HOLD_MS);
    };
    frameId = window.requestAnimationFrame(animate);
    return () => {
      window.cancelAnimationFrame(frameId);
      if (holdTimeout !== null) window.clearTimeout(holdTimeout);
    };
  }, [analysisPhase]);

  // ── Filling → Done ────────────────────────────────────────────────────────
  useEffect(() => {
    if (analysisPhase !== "filling") return;
    const target = targetScoreRef.current;
    let frameId = 0;
    let holdTimeout: number | null = null;
    const start = performance.now();
    const animate = (now: number) => {
      const raw = Math.min((now - start) / FILL_DURATION_MS, 1);
      setFillValue(target * easeOutCubic(raw));
      if (raw < 1) { frameId = window.requestAnimationFrame(animate); return; }
      holdTimeout = window.setTimeout(() => {
        setFillValue(target);
        setAnalysisPhase("done");
      }, FILL_HOLD_MS);
    };
    frameId = window.requestAnimationFrame(animate);
    return () => {
      window.cancelAnimationFrame(frameId);
      if (holdTimeout !== null) window.clearTimeout(holdTimeout);
    };
  }, [analysisPhase]);

  // ── Analyze ───────────────────────────────────────────────────────────────
  async function runAnalysis() {
    if (!listing) return;
    setAnalyzing(true);
    setAnalyzeError(null);
    setAnalysisPhase("loading");
    setCompressProgress(0);
    setFillValue(0);
    try {
      const isReanalyze = !!(analysisResult ?? (ai.aiScore != null ? ai : null));
      const res = await fetch(`${API_BASE}/api/search/analyze`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(isReanalyze ? { ...listing, _reanalyze: true } : listing),
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error(body?.error ?? `HTTP ${res.status}`);
      }
      const data = await res.json();
      const enriched: Listing = { ...listing, ...data, analyzedAt: undefined };
      const withTs = { ...enriched, analyzedAt: data.analyzedAt ?? new Date().toISOString() };
      targetScoreRef.current = data.aiScore ?? 0;
      setAnalysisResult(withTs);
      updateSavedListing(enriched);
      updateRecentlyViewed(enriched);
      navigate(".", { replace: true, state: { listing: enriched } });
      setCompressStartFrac((performance.now() - loadingStartRef.current) % LOADING_PERIOD_MS / LOADING_PERIOD_MS);
      setAnalysisPhase("compressing");
    } catch (err) {
      setAnalyzeError(err instanceof Error ? err.message : "Analysis failed");
      setAnalysisPhase(hasInitialScore || analysisResult != null ? "done" : "idle");
    } finally {
      setAnalyzing(false);
    }
  }

  // ── Hooks that must precede the early return ─────────────────────────────
  const money = useMemo(() => {
    try {
      return new Intl.NumberFormat(undefined, {
        style: "currency", currency: listing?.currency ?? "USD", maximumFractionDigits: 0,
      }).format(listing?.price ?? 0);
    } catch { return `$${listing?.price ?? 0}`; }
  }, [listing?.price, listing?.currency]);

  const sellerLine = useMemo(() => {
    if (!listing) return null;
    if (listing.source === "marketplace") return listing.location ? `\u{1F4CD} ${listing.location}` : null;
    return listing.seller?.trim() || null;
  }, [listing]);

  const similarListings = useMemo(() => {
    if (!listing) return [] as Listing[];
    try {
      const raw = sessionStorage.getItem(SEARCH_LISTINGS_KEY);
      if (!raw) return [] as Listing[];
      const parsed = JSON.parse(raw) as Listing[];
      if (!Array.isArray(parsed)) return [] as Listing[];
      return parsed
        .filter((item) => item && item.id && item.source && item.title)
        .filter((item) => !(item.id === listing.id && item.source === listing.source))
        .slice(0, 4);
    } catch { return [] as Listing[]; }
  }, [listing]);

  const [summaryChars, setSummaryChars] = useState(0);

  useEffect(() => {
    if (analysisPhase !== "done") { setSummaryChars(0); return; }
    const currentAi = analysisResult ?? listing;
    const overview = currentAi
      ? sanitizeVisibleText(currentAi.overview) ?? (looksLikeDebugPayload(currentAi.overview)
        ? "Analysis completed. Expand raw AI output if you want to inspect the underlying response."
        : currentAi.overview)
      : null;
    const text = overview ?? "";
    let chars = 0;
    const delay = window.setTimeout(() => {
      const interval = window.setInterval(() => {
        chars++;
        setSummaryChars(chars);
        if (chars >= text.length) window.clearInterval(interval);
      }, 12);
      return () => window.clearInterval(interval);
    }, 600);
    return () => window.clearTimeout(delay);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [analysisPhase]);

  if (!listing) {
    return (
      <p style={{ padding: 20 }}>
        No listing data found. Go back to search and click a listing card again.
      </p>
    );
  }

  // ── Derived values ────────────────────────────────────────────────────────

  const images = enrichedImages !== null && enrichedImages.length > 0
    ? enrichedImages : listing.images ?? [];
  const safeIndex    = Math.min(Math.max(imageIndex, 0), Math.max(images.length - 1, 0));
  const currentImage = getHighResImage(images[safeIndex] ?? "", listing.source);

  const ai          = analysisResult ?? listing;
  const targetScore = ai.aiScore ?? 0;
  const fillProgress = targetScore > 0
    ? Math.min(fillValue / targetScore, 1)
    : (analysisPhase === "done" ? 1 : 0);

  const visibleOverview = sanitizeVisibleText(ai.overview) ?? (looksLikeDebugPayload(ai.overview)
    ? "Analysis completed. Expand raw AI output if you want to inspect the underlying response."
    : ai.overview);

  const scores = {
    priceFairness:      ai.aiScores?.priceFairness,
    sellerTrust:        ai.aiScores?.sellerTrust,
    conditionHonesty:   ai.aiScores?.conditionHonesty,
    shippingFairness:   ai.aiScores?.shippingFairness,
    descriptionQuality: ai.aiScores?.descriptionQuality,
  };

  const readableLabels: Record<string, string> = {
    priceFairness:      "Price Fairness",
    sellerTrust:        listing.source === "marketplace" ? "Listing Confidence" : "Seller Trust",
    conditionHonesty:   "Condition Honesty",
    shippingFairness:   listing.source === "marketplace" ? "Pickup / Delivery Ease" : "Shipping Fairness",
    descriptionQuality: listing.source === "marketplace" ? "Listing Quality" : "Description Detail",
  };

  const showRing    = analysisPhase !== "idle";
  const showSummary = analysisPhase === "done" && ai.aiScore != null;

  // ── Render ────────────────────────────────────────────────────────────────

  const metaTitle = listing.title
    ? `${listing.title}${listing.price != null ? ` — ${money}` : ""} | Genuinely`
    : "Listing | Genuinely";
  const metaDescription = listing.title
    ? `${listing.title}${listing.price != null ? ` listed for ${money}` : ""} on ${sourceLabel(listing.source)}. AI deal analysis available on Genuinely.`
    : "View this listing and get an AI-powered deal score on Genuinely.";

  return (
    <div className="listing-page">
      <Helmet>
        <title>{metaTitle}</title>
        <meta name="description" content={metaDescription} />
      </Helmet>
      <div className="listing-card-block" style={{ flexDirection: "column" }}>
        <div className="listing-top-row">

          {/* Image panel */}
          <div className="page-image">
            <div className="image-frame">
              <img
                src={currentImage || "/placeholder.jpg"}
                alt={listing.title}
                onError={(e) => (e.currentTarget.src = "/placeholder.jpg")}
                className="image-frame-clickable"
                onClick={() => setViewerOpen(true)}
                title="Click to view full size"
              />
              {enrichLoading && listing.source === "marketplace" && (
                <span className="image-loading-badge">Loading gallery{"\u2026"}</span>
              )}
            </div>

            {images.length > 1 && (
              <div className="image-nav">
                <button onClick={() => setImageIndex((i) => (i === 0 ? images.length - 1 : i - 1))}>
                  {"\u2039"}
                </button>
                <span className="image-counter">{safeIndex + 1} / {images.length}</span>
                <button onClick={() => setImageIndex((i) => (i === images.length - 1 ? 0 : i + 1))}>
                  {"\u203A"}
                </button>
              </div>
            )}
          </div>

          {/* Info panel */}
          <div className="page-info" style={{ position: "relative" }}>

            {/* Title + heart */}
            <div style={{ display: "flex", alignItems: "center", gap: "10px" }}>
              <h1 className="page-title" style={{ margin: 0 }}>{listing.title}</h1>
              <button
                type="button"
                className="page-heart-inline"
                aria-pressed={saved}
                aria-label={saved ? "Unsave listing" : "Save listing"}
                onClick={(e) => { e.preventDefault(); e.stopPropagation(); setSaved(toggleSaved(listing)); }}
              >
                <svg viewBox="0 0 24 24" width="20" height="20" fill={saved ? "currentColor" : "none"} stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                  <path d="M20.84 4.61a5.5 5.5 0 0 0-7.78 0L12 5.67l-1.06-1.06a5.5 5.5 0 0 0-7.78 7.78l1.06 1.06L12 21.23l7.78-7.78 1.06-1.06a5.5 5.5 0 0 0 0-7.78z" />
                </svg>
              </button>
            </div>

            {/* Price / ring row */}
            <div className="info-ring-row" style={{ justifyContent: "flex-start", gap: "32px" }}>
              <div className="info-column">
                <div className="price-heart-row" style={{ alignItems: "center" }}>
                  {listing.acceptsOffers ? (
                    <div className="page-price-accepts-offers">
                      <p className="page-price page-price--offers">Accepts Offers</p>
                      <span className="page-price--offers-hint">Visit listing to determine price</span>
                    </div>
                  ) : (
                    <p className="page-price">{money}</p>
                  )}
                  {listing.shippingPrice != null ? (
                    <span className="page-shipping">
                      {listing.shippingPrice === 0
                        ? "Free shipping"
                        : `${listing.shippingEstimated ? "~" : "+ "}${new Intl.NumberFormat(undefined, { style: "currency", currency: listing.currency ?? "USD", minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(listing.shippingPrice)} shipping${listing.shippingEstimated ? " (est.)" : ""}`}
                    </span>
                  ) : listing.shippingCalculated ? (
                    <span className="page-shipping">Calculated shipping</span>
                  ) : null}
                </div>
                {listing.condition && <span className="page-condition">{listing.condition}</span>}
                {sellerLine && <p className="page-seller">{sellerLine}</p>}
                {listing.source === "marketplace" && Array.isArray(listing.delivery_types) && listing.delivery_types.length > 0 && (
                  <div className="page-delivery-types">
                    {listing.delivery_types.map((type) => (
                      <span key={type} className="page-delivery-badge">
                        {formatDeliveryType(type)}
                      </span>
                    ))}
                  </div>
                )}
              </div>

              <div className="ring-price-row">
                {/* Price bar — or invisible spacer so the ring stays in the same position */}
                {showRing && (ai.priceLow == null || ai.priceHigh == null) && (
                  <div aria-hidden="true" style={{ width: "220px", marginTop: "30px", flexShrink: 0 }} />
                )}
                {showRing && ai.priceLow != null && ai.priceHigh != null && (() => {
                  const { lowPct, midPct, highPct, fillPct } = buildPriceBarProps(
                    ai.priceLow, ai.priceHigh, listing.price
                  );
                  return (
                    <div
                      className={`demo-score-bar-wrap${analysisPhase !== "done" ? " demo-score-bar-wrap--pending" : ""}`}
                      style={{ marginTop: "30px" }}
                    >
                      {(() => {
                        const done = analysisPhase === "done" && listing.price != null && ai.priceLow != null && ai.priceHigh != null;
                        const badge = done ? getPriceBadge(listing.price!, ai.priceLow!, ai.priceHigh!) : null;
                        return (
                          <div
                            className="demo-score-bar-title"
                            style={badge ? { color: badge.color, background: badge.bg, borderColor: `${badge.color}48` } : undefined}
                          >
                            {badge?.label === "GREAT PRICE" && <StarSparkles />}
                            {badge ? badge.label : "Price Data"}
                          </div>
                        );
                      })()}
                      <div className="demo-score-bar-box">
                        <div className="demo-score-bar-track">
                          {analysisPhase === "done" && fillPct != null && (
                            <div className="demo-score-bar-fill demo-fade-in" style={{ left: `${fillPct}%` }} />
                          )}
                          <span className="demo-score-tick" style={{ left: `${lowPct}%` }} />
                          <span className="demo-score-tick" style={{ left: `${midPct}%`, transform: "translateX(-50%)" }} />
                          <span className="demo-score-tick" style={{ left: `${highPct}%`, transform: "translateX(-100%)" }} />
                          {analysisPhase === "done" && fillPct != null && (
                            <div className="demo-score-bar-price-label demo-fade-in" style={{ left: `${fillPct}%` }}>
                              <span>Listing Price</span>
                              <span className="demo-price-arrow" />
                            </div>
                          )}
                          <span className="demo-score-label-end" style={{ left: `${lowPct}%` }}>Low · ${ai.priceLow}</span>
                          <span className="demo-score-label-end" style={{ left: `${highPct}%` }}>High · ${ai.priceHigh}</span>
                        </div>
                      </div>
                    </div>
                  );
                })()}

                {/* Main ring */}
                {showRing && (
                  <div className="ring-main-container" style={{ position: "relative", width: "150px", height: "190px", flexShrink: 0, left: "28px" }}>
                    <div className="page-rating-ring demo-ring" style={{ position: "absolute", top: 0, left: 0 }}>
                      <AnimatedRing
                        phase={analysisPhase}
                        fillProgress={fillProgress}
                        compressProgress={compressProgress}
                        compressStartFrac={compressStartFrac}
                        targetValue={targetScore}
                        size={150}
                      />
                    </div>
                  </div>
                )}
              </div>
            </div>

            {/* Analyze button */}
            <div className="analyze-row">
              <button
                className="analyze-btn"
                onClick={runAnalysis}
                disabled={analyzing}
              >
                {analyzing
                  ? `Analyzing\u2026`
                  : analysisResult?.analyzedAt
                  ? "Re-analyze"
                  : ai.aiScore != null
                  ? "Re-analyze"
                  : "Analyze listing"}
              </button>
              <div style={{ display: "flex", alignItems: "center", gap: "10px", flexWrap: "wrap" }}>
                {analysisResult?.analyzedAt && (
                  <p className="analyze-subtext">
                    Last analyzed {new Date(analysisResult.analyzedAt).toLocaleString()}
                  </p>
                )}
                {!analysisResult?.analyzedAt && ai.aiScore != null && (
                  <p className="analyze-subtext">Previously analyzed</p>
                )}
                {(analysisResult?.analyzedAt || ai.aiScore != null) && !analyzing && (
                  <p className="analyze-hint">Something look off? Rerun analysis with the latest market data!</p>
                )}
              </div>
              {analyzeError && <p className="analyze-error">{analyzeError}</p>}
            </div>

            {/* External link */}
            <a
              className="external-ebay-link demo-external-link"
              href={listing.url}
              target="_blank"
              rel="noopener noreferrer"
            >
              View on {sourceLabel(listing.source)} {"\u2192"}
            </a>

            {/* Sub-rings */}
            {showRing && (
              <div className="ai-score-grid">
                {Object.entries(scores).map(([key, value]) => (
                  <div key={key} className="ai-score-item">
                    <AnimatedRing
                      phase={analysisPhase}
                      fillProgress={fillProgress}
                      compressProgress={compressProgress}
                      compressStartFrac={compressStartFrac}
                      targetValue={value ?? 0}
                      size={50}
                    />
                    <p className="ring-title">{readableLabels[key]}</p>
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>

        {/* Summary + at-a-glance + tabs */}
        {showSummary && (
          <div className="ai-overview-dropdown demo-fade-in" style={{ borderTop: "none", paddingTop: 0, marginTop: "0.25rem" }}>

            {/* At a glance */}
            {ai.highlights && ai.highlights.length > 0 && (
              <>
                <hr className="at-a-glance-hr" />
                <p className="at-a-glance-label">At a glance:</p>
                <div className="at-a-glance-badges">
                  {ai.highlights.map((h, i) => (
                    <span
                      key={i}
                      className={`at-a-glance-badge at-a-glance-badge--${h.positive ? "pos" : "neg"}`}
                    >
                      {h.positive ? "\u2713" : "\u2717"} {h.label}
                    </span>
                  ))}
                </div>
              </>
            )}

            <hr className="at-a-glance-hr" />

            {/* Tabs */}
            <div className="overview-tabs">
              <button
                className={`overview-tab${activeTab === "overview" ? " overview-tab--active" : ""}`}
                onClick={() => setActiveTab("overview")}
              >
                GENUINELY Overview
              </button>
              <button
                className={`overview-tab${activeTab === "details" ? " overview-tab--active" : ""}`}
                onClick={() => setActiveTab("details")}
              >
                Original Details
              </button>
            </div>

            {/* Overview tab */}
            {activeTab === "overview" && (
              <>
                <h3>Summary</h3>
                <p>
                  {(visibleOverview ?? "").slice(0, summaryChars)}
                  {summaryChars < (visibleOverview?.length ?? 0) && (
                    <span className="demo-typing-cursor" />
                  )}
                </p>

                {isAdmin && (
                  <>
                    {ai.marketContext && (
                      <>
                        <button className="ai-debug-toggle" onClick={() => setShowContext(!showContext)}>
                          {showContext ? "Hide market context \u2191" : "Show market context \u2193"}
                        </button>
                        {showContext && <pre className="debug-block">{ai.marketContext}</pre>}
                      </>
                    )}

                    {ai.systemPrompt && (
                      <>
                        <button className="ai-debug-toggle" onClick={() => setShowPrompt(!showPrompt)}>
                          {showPrompt ? "Hide analysis prompt \u2191" : "Show analysis prompt \u2193"}
                        </button>
                        {showPrompt && <pre className="debug-block">{ai.systemPrompt}</pre>}
                      </>
                    )}

                    <button className="ai-debug-toggle" onClick={() => setShowDebug(!showDebug)}>
                      {showDebug ? "Hide debug \u2191" : "Show debug info \u2193"}
                    </button>
                    {showDebug && <pre className="debug-block">{ai.debugInfo}</pre>}

                    <button className="ai-debug-toggle" onClick={() => setShowRaw(!showRaw)}>
                      {showRaw ? "Hide raw AI output \u2191" : "Show raw AI output \u2193"}
                    </button>
                    {showRaw && <pre className="debug-block">{ai.rawAnalysis}</pre>}
                  </>
                )}
              </>
            )}

            {/* Details tab */}
            {activeTab === "details" && (
              <div className="original-details-layout">
                <dl className="original-details-meta">
                  {listing.condition && <><dt>Condition</dt><dd>{listing.condition}</dd></>}
                  {listing.source === "marketplace"
                    ? listing.location && <><dt>Location</dt><dd>{listing.location}</dd></>
                    : listing.seller && <><dt>Seller</dt><dd>{listing.seller}</dd></>
                  }
                  {listing.price != null && (
                    <><dt>Price</dt><dd>{money}{listing.acceptsOffers ? " (Accepts Offers)" : ""}</dd></>
                  )}
                  {listing.shippingPrice != null && (
                    <><dt>Shipping</dt><dd>
                      {listing.shippingPrice === 0
                        ? "Free"
                        : `$${listing.shippingPrice}${listing.shippingEstimated ? " (est.)" : ""}`}
                    </dd></>
                  )}
                  {listing.feedback && <><dt>Feedback</dt><dd>{listing.feedback}</dd></>}
                  {Array.isArray(listing.delivery_types) && listing.delivery_types.length > 0 && (
                    <><dt>Delivery</dt><dd>{listing.delivery_types.join(", ")}</dd></>
                  )}
                </dl>
                <div className="original-details-divider" />
                <div className="original-details-desc">
                  <p className="at-a-glance-label" style={{ marginBottom: "0.6rem" }}>Seller's Description</p>
                  {sanitizeVisibleText(listing.fullDescription ?? listing.description)
                    ? <p className="page-description">{sanitizeVisibleText(listing.fullDescription ?? listing.description)}</p>
                    : <p style={{ color: "rgba(255,255,255,0.3)", fontSize: "0.85rem" }}>No description provided.</p>
                  }
                </div>
              </div>
            )}
          </div>
        )}
      </div>

      {/* Image viewer */}
      {viewerOpen && (
        <div
          className="image-viewer-overlay"
          onClick={() => setViewerOpen(false)}
          role="dialog" aria-modal="true" aria-label="Image viewer"
        >
          <button className="image-viewer-close" onClick={() => setViewerOpen(false)} aria-label="Close image viewer">
            &times;
          </button>
          <button
            className="image-viewer-nav image-viewer-nav--prev"
            onClick={(e) => { e.stopPropagation(); setImageIndex((i) => (i === 0 ? images.length - 1 : i - 1)); }}
            aria-label="Previous image"
          >
            {"\u2039"}
          </button>
          <div className="image-viewer-content" onClick={(e) => e.stopPropagation()}>
            <img
              src={currentImage || "/placeholder.jpg"}
              alt={listing.title}
              onError={(e) => (e.currentTarget.src = "/placeholder.jpg")}
            />
          </div>
          <button
            className="image-viewer-nav image-viewer-nav--next"
            onClick={(e) => { e.stopPropagation(); setImageIndex((i) => (i === images.length - 1 ? 0 : i + 1)); }}
            aria-label="Next image"
          >
            {"\u203A"}
          </button>
          {images.length > 1 && (
            <div className="image-viewer-counter">{safeIndex + 1} / {images.length}</div>
          )}
        </div>
      )}

      {/* Similar listings */}
      {(similarListings.length > 0 || fetchedSimilar.length > 0) && (
        <section className="similar-listings-section" aria-label="You may like similar listings">
          <h2 className="similar-listings-title">You may like</h2>
          <div className="similar-listings-grid">
            {(similarListings.length > 0 ? similarListings : fetchedSimilar).map((item) => (
              <div className="similar-card" key={`${item.source}:${item.id}`}>
                <ListingCard data={item} />
              </div>
            ))}
          </div>
        </section>
      )}
    </div>
  );
}
