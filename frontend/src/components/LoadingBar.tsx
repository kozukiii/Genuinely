import { useEffect, useRef, useState } from "react";
import "./LoadingBar.css";

export type PipelinePhase = "idle" | "fetching" | "context" | "scoring" | "retrying" | "done";

export interface PipelineStatus {
  phase: PipelinePhase;
  groupsDone?: number;
  groupsTotal?: number;
  listingsScored?: number;
  elapsedSeconds?: number;
  // True for combined single-batch mode, where scores land all at once with no
  // per-group progress. The bar fakes forward motion (capped) + rotating labels.
  combined?: boolean;
}

// Implied work shown during the combined-batch wait. We can't report real
// sub-steps (it's one opaque batch job), so we narrate plausible stages.
const SCORING_STEPS = [
  "Comparing market data...",
  "Checking recent sold prices...",
  "Evaluating seller signals...",
  "Assessing condition & description...",
  "Weighing shipping & fees...",
  "Finalizing scores...",
];
const SCORING_STEP_MS = 4000;   // ~6 steps over ~24s, pacing the ~27s batch wait
const SCORING_BASE = 58;        // where the scoring phase starts
const SCORING_CRAWL_CAP = 85;   // bar never fakes past this while awaiting the batch

// Map the current implied-step index to a bar target, so the bar advances one
// notch each time the label changes (steps span SCORING_BASE → SCORING_CRAWL_CAP).
function scoringStepTarget(step: number): number {
  const frac = (step + 1) / SCORING_STEPS.length;
  return SCORING_BASE + frac * (SCORING_CRAWL_CAP - SCORING_BASE);
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
  const [scoringStep, setScoringStep] = useState(0);

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

    // In combined mode the scoring phase has no real sub-progress, so drive the
    // target off the implied step index — the bar steps forward with each label.
    targetRef.current = phase === "scoring" && status.combined
      ? Math.max(scoringStepTarget(scoringStep), phaseTarget(phase, groupsDone, groupsTotal))
      : phaseTarget(phase, groupsDone, groupsTotal);

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
  }, [phase, groupsDone, groupsTotal, scoringStep, status.combined]);

  // Rotate the implied-step label while waiting on the combined batch. Advance and
  // hold on the last step rather than looping, so it never feels like it regresses.
  useEffect(() => {
    if (phase !== "scoring" || !status.combined) {
      setScoringStep(0);
      return;
    }
    const id = setInterval(
      () => setScoringStep((s) => Math.min(s + 1, SCORING_STEPS.length - 1)),
      SCORING_STEP_MS,
    );
    return () => clearInterval(id);
  }, [phase, status.combined]);

  let displayLabel: string;
  if (phase === "done" && summary) {
    displayLabel = `Analyzed ${summary.count} listing${summary.count !== 1 ? "s" : ""} in ${summary.elapsed}s`;
  } else if (phase === "scoring" && status.combined) {
    displayLabel = SCORING_STEPS[scoringStep];
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
