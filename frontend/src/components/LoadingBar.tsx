import { useEffect, useRef, useState } from "react";
import "./LoadingBar.css";

export type PipelinePhase = "idle" | "fetching" | "context" | "scoring" | "retrying" | "done";

export interface PipelineStatus {
  phase: PipelinePhase;
  groupsDone?: number;
  groupsTotal?: number;
  listingsScored?: number;
  elapsedSeconds?: number;
}

function phaseTarget(phase: PipelinePhase, groupsDone: number, groupsTotal: number): number {
  switch (phase) {
    case "idle":     return 0;
    case "fetching": return 22;
    case "context":  return 58;
    case "scoring":  return groupsTotal > 0 ? 58 + (groupsDone / groupsTotal) * 37 : 62;
    case "retrying": return 96;
    case "done":     return 100;
  }
}

const CONTEXT_CRAWL_SPEED = 0.006;
const CONTEXT_CRAWL_ZONE  = 8;

export default function LoadingBar({ status }: { status: PipelineStatus }) {
  const { phase, groupsDone = 0, groupsTotal = 0 } = status;

  const [visible, setVisible]   = useState(false);
  const [barWidth, setBarWidth] = useState(0);
  const [summary, setSummary]   = useState<{ elapsed: string; count: number } | null>(null);

  const widthRef     = useRef(0);
  const targetRef    = useRef(0);
  const phaseRef     = useRef(phase);
  const rafRef       = useRef<number | undefined>();
  const startTimeRef = useRef<number | null>(null);

  phaseRef.current = phase;

  // Visibility + summary
  useEffect(() => {
    if (phase === "fetching") {
      setVisible(true);
      setSummary(null);
      startTimeRef.current = Date.now();
      return;
    }
    if (phase === "idle") {
      setVisible(false);
      return;
    }
    if (phase === "done") {
      setVisible(true);
      const elapsed = startTimeRef.current != null
        ? ((Date.now() - startTimeRef.current) / 1000).toFixed(1)
        : status.elapsedSeconds != null
          ? status.elapsedSeconds.toFixed(1)
          : null;
      const count = status.listingsScored ?? 0;
      setSummary(elapsed ? { elapsed, count } : null);
      return;
    }
    setVisible(true);
  }, [phase]);

  // Animated progress
  useEffect(() => {
    if (rafRef.current) cancelAnimationFrame(rafRef.current);

    if (phase === "done") {
      widthRef.current = 100;
      setBarWidth(100);
      return;
    }
    if (phase === "idle") {
      widthRef.current = 0;
      setBarWidth(0);
      return;
    }

    targetRef.current = phaseTarget(phase, groupsDone, groupsTotal);

    function tick() {
      const currentPhase = phaseRef.current;
      const target = targetRef.current;
      const d = target - widthRef.current;

      if (currentPhase === "context") {
        if (d <= 0.01) {
          rafRef.current = requestAnimationFrame(tick);
          return;
        }
        const step = d > CONTEXT_CRAWL_ZONE ? d * 0.045 : CONTEXT_CRAWL_SPEED;
        widthRef.current = Math.min(widthRef.current + step, target - 0.01);
        setBarWidth(widthRef.current);
        rafRef.current = requestAnimationFrame(tick);
        return;
      }

      if (Math.abs(d) >= 0.04) {
        widthRef.current += d * 0.045;
        setBarWidth(widthRef.current);
        rafRef.current = requestAnimationFrame(tick);
      }
    }

    rafRef.current = requestAnimationFrame(tick);
    return () => { if (rafRef.current) cancelAnimationFrame(rafRef.current); };
  }, [phase, groupsDone, groupsTotal]);

  let displayLabel: string;
  if (phase === "done" && summary) {
    displayLabel = `Analyzed ${summary.count} listing${summary.count !== 1 ? "s" : ""} in ${summary.elapsed}s`;
  } else if (phase === "scoring" && groupsTotal > 1) {
    displayLabel = `Scoring listings — ${groupsDone} of ${groupsTotal} done`;
  } else {
    const LABELS: Record<PipelinePhase, string> = {
      idle: "", fetching: "Finding listings...", context: "Looking up market prices...",
      scoring: "Scoring listings...", retrying: "Wrapping up...", done: "",
    };
    displayLabel = LABELS[phase];
  }

  if (!visible) return null;

  return (
    <div className="lb-wrap">
      <div className="lb-track">
        <div className="lb-fill" style={{ width: `${barWidth}%` }} />
      </div>
      {displayLabel && (
        <span className={`lb-label${phase === "done" ? " lb-label--done" : ""}`}>
          {displayLabel}
        </span>
      )}
    </div>
  );
}
