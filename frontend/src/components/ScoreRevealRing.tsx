import { useEffect, useRef, useState, type CSSProperties } from "react";
import RatingRing from "./RatingRing";
import "./styles/ScoreRevealRing.css";

export type ScoreRevealPhase = "idle" | "loading" | "compressing" | "filling" | "done";

export const COMPRESS_DURATION_MS = 1000;
export const COMPRESS_HOLD_MS = 90;
export const FILL_DURATION_MS = 700;
export const FILL_HOLD_MS = 120;
export const LOADING_PERIOD_MS = 1200;
const COMPRESS_AFTER_TOP_PROGRESS = 0.12;
const LOADING_ARC_FRACTION = 0.32;
const LOADING_SCORE = LOADING_ARC_FRACTION * 100;
const HUE_SHIFT_DELAY_MS = 400;

export const easeInOutQuad = (t: number) => t < 0.5 ? 2 * t * t : -1 + (4 - 2 * t) * t;
export const easeOutCubic = (t: number) => 1 - (1 - t) ** 3;

function scoreColor(score: number) {
  if (score >= 67) return "#22c55e";
  if (score >= 33) return "#facc15";
  return "#ef4444";
}

export function ScoreRevealRing({
  phase, fillProgress, compressProgress, compressStartFrac, targetValue, size,
}: {
  phase: ScoreRevealPhase;
  fillProgress: number;
  compressProgress: number;
  compressStartFrac: number;
  targetValue: number;
  size: number;
}) {
  const [colorReady, setColorReady] = useState(false);

  useEffect(() => {
    if (phase !== "done") { setColorReady(false); return; }
    const timer = window.setTimeout(() => setColorReady(true), HUE_SHIFT_DELAY_MS);
    return () => window.clearTimeout(timer);
  }, [phase]);

  const center = size / 2;
  const radius = size * 0.37;
  const strokeW = size * 0.10;
  const circumference = 2 * Math.PI * radius;
  const loadingOffset = circumference * (1 - LOADING_ARC_FRACTION);
  const compressBlend = Math.min(Math.max((compressProgress - COMPRESS_AFTER_TOP_PROGRESS) / (1 - COMPRESS_AFTER_TOP_PROGRESS), 0), 1);
  const compressOffset = circumference - (LOADING_SCORE * (1 - compressBlend) / 100) * circumference;
  const fillColor = scoreColor(targetValue);

  if (phase === "loading" || phase === "compressing") {
    return (
      <svg
        className={phase === "loading" ? "score-reveal-ring--loading" : undefined}
        style={{
          width: size, height: size, overflow: "visible", transformBox: "fill-box",
          transformOrigin: "center", flexShrink: 0, "--score-reveal-color": fillColor,
          transform: phase === "compressing" ? `rotate(${(compressStartFrac + compressProgress * (1 - compressStartFrac)) * 360}deg)` : undefined,
        } as CSSProperties}
        width={size} height={size} viewBox={`0 0 ${size} ${size}`}
      >
        <circle className="score-reveal-ring__track" cx={center} cy={center} r={radius} strokeWidth={strokeW} fill="none" />
        <circle
          className={`score-reveal-ring__arc score-reveal-ring__arc--${phase}`}
          cx={center} cy={center} r={radius} strokeWidth={strokeW} fill="none" strokeLinecap="round"
          transform={`rotate(-90 ${center} ${center})`}
          style={{ strokeDasharray: circumference, strokeDashoffset: phase === "loading" ? loadingOffset : compressOffset }}
        />
      </svg>
    );
  }

  if (phase === "idle") return null;
  return <RatingRing value={fillProgress * targetValue} size={size} color={colorReady ? fillColor : "#3b82f6"} />;
}

export function AutoScoreRevealRing({ value, pending, size }: { value?: number | null; pending: boolean; size: number }) {
  const initialValue = typeof value === "number" ? value : 0;
  const [phase, setPhase] = useState<ScoreRevealPhase>(pending ? "loading" : typeof value === "number" ? "done" : "idle");
  const [compressProgress, setCompressProgress] = useState(0);
  const [compressStartFrac, setCompressStartFrac] = useState(0);
  const [fillValue, setFillValue] = useState(initialValue);
  const targetRef = useRef(initialValue);
  const loadingStartedRef = useRef(performance.now());
  const wasPendingRef = useRef(pending);

  useEffect(() => {
    if (pending && typeof value !== "number") {
      wasPendingRef.current = true;
      loadingStartedRef.current = performance.now();
      setPhase("loading");
      return;
    }
    if (typeof value !== "number") {
      setPhase("idle");
      return;
    }
    targetRef.current = value;
    if (wasPendingRef.current) {
      wasPendingRef.current = false;
      setCompressStartFrac(((performance.now() - loadingStartedRef.current) % LOADING_PERIOD_MS) / LOADING_PERIOD_MS);
      setCompressProgress(0);
      setFillValue(0);
      setPhase("compressing");
    } else {
      setFillValue(value);
      setPhase("done");
    }
  }, [pending, value]);

  useEffect(() => {
    if (phase !== "compressing") return;
    let frame = 0;
    let holdTimer: number | null = null;
    const start = performance.now();
    const animate = (now: number) => {
      const raw = Math.min((now - start) / COMPRESS_DURATION_MS, 1);
      setCompressProgress(easeInOutQuad(raw));
      if (raw < 1) frame = requestAnimationFrame(animate);
      else holdTimer = window.setTimeout(() => setPhase("filling"), COMPRESS_HOLD_MS);
    };
    frame = requestAnimationFrame(animate);
    return () => {
      cancelAnimationFrame(frame);
      if (holdTimer !== null) window.clearTimeout(holdTimer);
    };
  }, [phase]);

  useEffect(() => {
    if (phase !== "filling") return;
    let frame = 0;
    let holdTimer: number | null = null;
    const start = performance.now();
    const animate = (now: number) => {
      const raw = Math.min((now - start) / FILL_DURATION_MS, 1);
      setFillValue(targetRef.current * easeOutCubic(raw));
      if (raw < 1) frame = requestAnimationFrame(animate);
      else holdTimer = window.setTimeout(() => { setFillValue(targetRef.current); setPhase("done"); }, FILL_HOLD_MS);
    };
    frame = requestAnimationFrame(animate);
    return () => {
      cancelAnimationFrame(frame);
      if (holdTimer !== null) window.clearTimeout(holdTimer);
    };
  }, [phase]);

  const fillProgress = targetRef.current > 0 ? Math.min(fillValue / targetRef.current, 1) : phase === "done" ? 1 : 0;
  return <ScoreRevealRing phase={phase} fillProgress={fillProgress} compressProgress={compressProgress} compressStartFrac={compressStartFrac} targetValue={targetRef.current} size={size} />;
}
