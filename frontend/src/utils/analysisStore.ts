import type { Listing } from "../types/Listing";

type ScoreCallback = (listing: Listing | null) => void;

// Module-level maps persist across route changes (unlike component state/refs)
const pendingCallbacks = new Map<string, Set<ScoreCallback>>();
const completedListings = new Map<string, Listing>();

function key(l: Pick<Listing, "id" | "source">) {
  return `${l.source}:${l.id}`;
}

/**
 * Subscribe to a listing's background analysis score.
 * If the score already arrived, the callback fires synchronously.
 * Callback receives null on analysis failure.
 * Returns an unsubscribe function (call on component unmount).
 */
export function subscribeToAnalysis(
  listing: Pick<Listing, "id" | "source">,
  cb: ScoreCallback,
): () => void {
  const k = key(listing);
  const cached = completedListings.get(k);
  if (cached) {
    cb(cached);
    return () => {};
  }
  let callbacks = pendingCallbacks.get(k);
  if (!callbacks) {
    callbacks = new Set();
    pendingCallbacks.set(k, callbacks);
  }
  callbacks.add(cb);
  return () => {
    pendingCallbacks.get(k)?.delete(cb);
  };
}

/** Called by the analysis pipeline when a listing has been scored. */
export function publishAnalysisResult(listing: Listing): void {
  const k = key(listing);
  completedListings.set(k, listing);
  const callbacks = pendingCallbacks.get(k);
  if (callbacks) {
    callbacks.forEach((cb) => cb(listing));
    pendingCallbacks.delete(k);
  }
}

/** Called by the analysis pipeline when scoring failed for a listing. */
export function publishAnalysisFailure(listing: Pick<Listing, "id" | "source">): void {
  const k = key(listing);
  const callbacks = pendingCallbacks.get(k);
  if (callbacks) {
    callbacks.forEach((cb) => cb(null));
    pendingCallbacks.delete(k);
  }
}

/** Clear all state — call when a new search begins. */
export function clearAnalysisStore(): void {
  pendingCallbacks.clear();
  completedListings.clear();
}
