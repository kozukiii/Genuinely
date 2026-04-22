import db from "../db";

db.exec(`
  CREATE TABLE IF NOT EXISTS ai_usage (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    provider     TEXT    NOT NULL,
    model        TEXT    NOT NULL,
    prompt_tokens    INTEGER NOT NULL DEFAULT 0,
    completion_tokens INTEGER NOT NULL DEFAULT 0,
    total_tokens INTEGER NOT NULL DEFAULT 0,
    logged_at    INTEGER NOT NULL DEFAULT (unixepoch())
  );
`);

export function logUsage(provider: string, model: string, usage: { prompt_tokens: number; completion_tokens: number; total_tokens: number } | null | undefined) {
  if (!usage) return;
  db.prepare(
    "INSERT INTO ai_usage (provider, model, prompt_tokens, completion_tokens, total_tokens) VALUES (?, ?, ?, ?, ?)"
  ).run(provider, model, usage.prompt_tokens, usage.completion_tokens, usage.total_tokens);
}

export function getUsageSummary() {
  return db.prepare(`
    SELECT provider, model,
      SUM(prompt_tokens)      AS prompt_tokens,
      SUM(completion_tokens)  AS completion_tokens,
      SUM(total_tokens)       AS total_tokens,
      COUNT(*)                AS calls
    FROM ai_usage
    GROUP BY provider, model
    ORDER BY total_tokens DESC
  `).all() as { provider: string; model: string; prompt_tokens: number; completion_tokens: number; total_tokens: number; calls: number }[];
}
