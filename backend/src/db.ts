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

export default db;
