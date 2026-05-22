// Escape literal newlines/carriage-returns inside JSON string values so that
// individual objects damaged by the model's line-break habit can still parse.
function repairLiteralNewlines(s: string): string {
  let out = "";
  let inString = false;
  let escaped = false;
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (escaped) { out += ch; escaped = false; continue; }
    if (ch === "\\") { escaped = true; out += ch; continue; }
    if (ch === '"') { inString = !inString; out += ch; continue; }
    if (inString && ch === "\r") continue;
    if (inString && ch === "\n") { out += "\\n"; continue; }
    out += ch;
  }
  return out;
}

/**
 * Extract each top-level `{...}` object from a model response by tracking
 * brace depth.  Resilient to:
 *  - missing commas between array objects
 *  - stray text before/after the array wrapper
 *  - literal newlines inside string values
 *
 * Each object is parsed individually, so one bad entry cannot fail the whole
 * batch.  Objects that cannot be repaired are silently skipped.
 */
export function extractBatchObjects(raw: string): any[] {
  const results: any[] = [];
  let depth = 0;
  let start = -1;
  let inString = false;
  let escaped = false;

  for (let i = 0; i < raw.length; i++) {
    const ch = raw[i];
    if (escaped) { escaped = false; continue; }
    if (ch === "\\" && inString) { escaped = true; continue; }
    if (ch === '"') { inString = !inString; continue; }
    if (inString) continue;

    if (ch === "{") {
      if (depth === 0) start = i;
      depth++;
    } else if (ch === "}") {
      depth--;
      if (depth === 0 && start !== -1) {
        const slice = raw.slice(start, i + 1);
        try {
          results.push(JSON.parse(slice));
        } catch {
          try {
            results.push(
              JSON.parse(
                repairLiteralNewlines(slice).replace(/,(\s*[}\]])/g, "$1"),
              ),
            );
          } catch {
            // Truly unparseable — skip this object, do not fail the whole batch
          }
        }
        start = -1;
      }
    }
  }

  return results;
}
