type ParsedAnalysis = {
  scores?: Record<string, number | null>;
  overview?: string;
};

function sanitizeOverview(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;

  const trimmed = value.trim();
  if (!trimmed) return undefined;

  const withoutDebug = trimmed.split(/\bDEBUG INFO:\b/i)[0]?.trim() ?? trimmed;
  return withoutDebug || undefined;
}

function tryParseObject(candidate: string): ParsedAnalysis | null {
  try {
    const parsed = JSON.parse(candidate);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
    return parsed as ParsedAnalysis;
  } catch {
    return null;
  }
}

function extractFirstJsonObject(text: string): ParsedAnalysis | null {
  const start = text.indexOf("{");
  if (start === -1) return null;

  let depth = 0;
  let inString = false;
  let escaped = false;

  for (let i = start; i < text.length; i += 1) {
    const ch = text[i];

    if (inString) {
      if (escaped) {
        escaped = false;
      } else if (ch === "\\") {
        escaped = true;
      } else if (ch === "\"") {
        inString = false;
      }
      continue;
    }

    if (ch === "\"") {
      inString = true;
      continue;
    }

    if (ch === "{") depth += 1;
    if (ch === "}") {
      depth -= 1;
      if (depth === 0) {
        return tryParseObject(text.slice(start, i + 1));
      }
    }
  }

  return null;
}

export function extractStructuredAnalysis(analysis: string): ParsedAnalysis | null {
  const trimmed = analysis.trim();

  const whole = tryParseObject(trimmed);
  if (whole) {
    return {
      ...whole,
      overview: sanitizeOverview(whole.overview),
    };
  }

  const beforeDebug = trimmed.split(/\bDEBUG INFO:\b/i)[0]?.trim() ?? trimmed;
  const beforeDebugParsed = tryParseObject(beforeDebug);
  if (beforeDebugParsed) {
    return {
      ...beforeDebugParsed,
      overview: sanitizeOverview(beforeDebugParsed.overview),
    };
  }

  const firstObject = extractFirstJsonObject(trimmed);
  if (!firstObject) return null;

  return {
    ...firstObject,
    overview: sanitizeOverview(firstObject.overview),
  };
}
