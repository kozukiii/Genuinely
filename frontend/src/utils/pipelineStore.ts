import type { PipelineStatus } from "../components/LoadingBar";
import type { ListingSource } from "../types/Listing";

const PIPELINE_KEY = "search:pipeline";

export type PipelineStatusMap = Partial<Record<ListingSource, PipelineStatus>>;
type StatusCallback = (statuses: PipelineStatusMap) => void;

function loadInitial(): PipelineStatusMap {
  try {
    const raw = sessionStorage.getItem(PIPELINE_KEY);
    if (raw) return JSON.parse(raw) as PipelineStatusMap;
  } catch { /* ignore */ }
  return {};
}

let currentStatuses: PipelineStatusMap = loadInitial();
const subscribers = new Set<StatusCallback>();

function persistAndNotify() {
  try {
    sessionStorage.setItem(PIPELINE_KEY, JSON.stringify(currentStatuses));
  } catch { /* ignore */ }
  subscribers.forEach((cb) => cb(currentStatuses));
}

/** Update the status for a single source's analysis pipeline. */
export function publishPipelineStatus(source: ListingSource, status: PipelineStatus): void {
  currentStatuses = { ...currentStatuses, [source]: status };
  persistAndNotify();
}

/** Reset the board to the given sources, each starting in `fetching`. Sources not
 *  listed are cleared so stale bars from a previous search don't linger. */
export function resetPipelineStatuses(sources: ListingSource[]): void {
  const next: PipelineStatusMap = {};
  for (const source of sources) next[source] = { phase: "fetching" };
  currentStatuses = next;
  persistAndNotify();
}

/**
 * Subscribe to pipeline status updates. Fires synchronously with the current
 * statuses so callers always start in the right state, including mid-flight
 * pipelines that were running while the component was unmounted.
 */
export function subscribeToPipelineStatus(cb: StatusCallback): () => void {
  cb(currentStatuses);
  subscribers.add(cb);
  return () => subscribers.delete(cb);
}
