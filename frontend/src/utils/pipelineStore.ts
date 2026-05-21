import type { PipelineStatus } from "../components/LoadingBar";

const PIPELINE_KEY = "search:pipeline";

type StatusCallback = (status: PipelineStatus) => void;

function loadInitial(): PipelineStatus {
  try {
    const raw = sessionStorage.getItem(PIPELINE_KEY);
    if (raw) return JSON.parse(raw) as PipelineStatus;
  } catch { /* ignore */ }
  return { phase: "idle" };
}

let currentStatus: PipelineStatus = loadInitial();
const subscribers = new Set<StatusCallback>();

export function publishPipelineStatus(status: PipelineStatus): void {
  currentStatus = status;
  try {
    sessionStorage.setItem(PIPELINE_KEY, JSON.stringify(status));
  } catch { /* ignore */ }
  subscribers.forEach((cb) => cb(status));
}

/**
 * Subscribe to pipeline status updates. Fires synchronously with the current
 * status so callers always start in the right state, including mid-flight
 * pipelines that were running while the component was unmounted.
 */
export function subscribeToPipelineStatus(cb: StatusCallback): () => void {
  cb(currentStatus);
  subscribers.add(cb);
  return () => subscribers.delete(cb);
}
