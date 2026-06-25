import Database from "better-sqlite3";
import path from "path";
import fs from "fs";

const dbPath = path.join(process.env.DATA_DIR ?? path.join(process.cwd(), "data"), "genuinely.db");

// Ensure the directory exists (matters for local dev; Render disk is pre-mounted)
const dir = path.dirname(dbPath);
if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

const db = new Database(dbPath);

db.pragma("journal_mode = WAL");
db.pragma("foreign_keys = ON");

db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    google_id   TEXT    NOT NULL UNIQUE,
    email       TEXT    NOT NULL,
    display_name TEXT   NOT NULL,
    created_at  INTEGER NOT NULL DEFAULT (unixepoch())
  );

  CREATE TABLE IF NOT EXISTS saved_listings (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id     INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    source      TEXT    NOT NULL,
    listing_id  TEXT    NOT NULL,
    data        TEXT    NOT NULL,
    saved_at    INTEGER NOT NULL DEFAULT (unixepoch()),
    UNIQUE(user_id, source, listing_id)
  );
`);

// ── One-time scrub: strip copyrighted source content from existing saved rows ──
// Earlier code persisted whole listing blobs (title/images/description/price/etc.)
// to disk. This rewrites every saved_listings.data down to the analysis-only
// allowlist so no scraped content remains. Idempotent + guarded by a flag row so
// it runs at most once.
const ALLOWED_SAVED_FIELDS = new Set([
  "id", "source", "crossListedEbayId",
  "score", "aiScore", "aiScores", "overview", "highlights",
  "priceLow", "priceHigh", "priceSource", "priceChartingUrl", "tcgPlayerUrl",
  "availabilityStatus", "availabilityCheckedAt", "availabilityReason",
  "lastSeenActiveAt", "endedAt", "analysisSkipped", "analyzedAt",
]);

db.exec(`
  CREATE TABLE IF NOT EXISTS migrations (
    name      TEXT    PRIMARY KEY,
    ran_at    INTEGER NOT NULL DEFAULT (unixepoch())
  );
`);

// last_seen: most-recent authenticated activity per user (bumped, throttled, by
// requireAuth). Added via ALTER since the users table predates it. Nullable —
// older accounts read NULL until their next request.
const hasLastSeen = (db.prepare("PRAGMA table_info(users)").all() as { name: string }[])
  .some((c) => c.name === "last_seen");
if (!hasLastSeen) {
  db.exec("ALTER TABLE users ADD COLUMN last_seen INTEGER");
}

const SCRUB_MIGRATION = "scrub_saved_listings_content_v1";
const alreadyRun = db.prepare("SELECT 1 FROM migrations WHERE name = ?").get(SCRUB_MIGRATION);

if (!alreadyRun) {
  const rows = db.prepare("SELECT id, data FROM saved_listings").all() as { id: number; data: string }[];
  const update = db.prepare("UPDATE saved_listings SET data = ? WHERE id = ?");

  const scrub = db.transaction(() => {
    for (const row of rows) {
      let parsed: Record<string, unknown>;
      try { parsed = JSON.parse(row.data); } catch { parsed = {}; }

      const out: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(parsed)) {
        if (ALLOWED_SAVED_FIELDS.has(k)) out[k] = v;
      }
      update.run(JSON.stringify(out), row.id);
    }
    db.prepare("INSERT INTO migrations (name) VALUES (?)").run(SCRUB_MIGRATION);
  });

  scrub();
  console.warn(`[db] scrubbed ${rows.length} saved_listings rows down to analysis-only fields`);
}

export default db;
