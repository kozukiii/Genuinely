import fs from "fs";
import path from "path";

const CACHE_PATH = path.join(process.env.DATA_DIR ?? path.join(process.cwd(), "data"), "analysis-cache.json");
const TTL_MS = 4 * 60 * 60 * 1000; // 4 hours
const MAX_ENTRIES = 500;

export interface AnalysisCacheEntry {
  scoredAt: string;
  aiScore: number | null;
  aiScores: Record<string, number | null | undefined>;
  overview: string;
  highlights?: { label: string; positive: boolean }[];
}

type AnalysisCacheStore = Record<string, AnalysisCacheEntry>;

function readStore(): AnalysisCacheStore {
  try {
    const raw = fs.readFileSync(CACHE_PATH, "utf-8");
    return JSON.parse(raw) as AnalysisCacheStore;
  } catch {
    return {};
  }
}

function writeStore(store: AnalysisCacheStore) {
  try {
    fs.mkdirSync(path.dirname(CACHE_PATH), { recursive: true });
    fs.writeFileSync(CACHE_PATH, JSON.stringify(store), "utf-8");
  } catch (err) {
    console.error("[analysisCache] Failed to write cache:", err);
  }
}

function evict(store: AnalysisCacheStore): AnalysisCacheStore {
  const now = Date.now();

  // Drop expired entries first
  const live = Object.fromEntries(
    Object.entries(store).filter(([, v]) => now - new Date(v.scoredAt).getTime() <= TTL_MS)
  );

  // Cap at MAX_ENTRIES — drop oldest by scoredAt
  const entries = Object.entries(live);
  if (entries.length <= MAX_ENTRIES) return live;

  entries.sort((a, b) => new Date(a[1].scoredAt).getTime() - new Date(b[1].scoredAt).getTime());
  return Object.fromEntries(entries.slice(entries.length - MAX_ENTRIES));
}

function isExpired(entry: AnalysisCacheEntry): boolean {
  return Date.now() - new Date(entry.scoredAt).getTime() > TTL_MS;
}

export function getCachedAnalysis(source: string, id: string): AnalysisCacheEntry | null {
  const store = readStore();
  const entry = store[`${source}-${id}`];
  if (!entry || isExpired(entry)) return null;
  return entry;
}

// Read store once, then look up many entries without re-reading disk.
export function readCacheStore(): AnalysisCacheStore {
  return readStore();
}

export function getCachedAnalysisFromStore(store: AnalysisCacheStore, source: string, id: string): AnalysisCacheEntry | null {
  const entry = store[`${source}-${id}`];
  if (!entry || isExpired(entry)) return null;
  return entry;
}

export function deleteCachedAnalysis(source: string, id: string) {
  const store = readStore();
  delete store[`${source}-${id}`];
  writeStore(store);
}

export function setCachedAnalysis(source: string, id: string, result: Omit<AnalysisCacheEntry, "scoredAt">) {
  const store = readStore();
  store[`${source}-${id}`] = { scoredAt: new Date().toISOString(), ...result };
  writeStore(evict(store));
}

// Write multiple entries in a single read+write cycle — use this after batch scoring.
export function setCachedAnalysisBatch(
  entries: Array<{ source: string; id: string; result: Omit<AnalysisCacheEntry, "scoredAt"> }>
) {
  if (entries.length === 0) return;
  const store = readStore();
  const now = new Date().toISOString();
  for (const { source, id, result } of entries) {
    store[`${source}-${id}`] = { scoredAt: now, ...result };
  }
  writeStore(evict(store));
}
