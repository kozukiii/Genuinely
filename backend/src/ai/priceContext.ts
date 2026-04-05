import fetch from "node-fetch";
import dotenv from "dotenv";

dotenv.config({ quiet: true });

const SERPER_URL = "https://google.serper.dev/search";
const TIMEOUT_MS = 6000;

export async function fetchMarketContext(query: string): Promise<string | null> {
  const apiKey = process.env.SERPER_API_KEY;
  if (!apiKey) {
    console.warn("[priceContext] SERPER_API_KEY not set — skipping market context");
    return null;
  }

  const searchQuery = `${query} used resale price 2025`;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);

  try {
    const res = await fetch(SERPER_URL, {
      method: "POST",
      headers: {
        "X-API-KEY": apiKey,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ q: searchQuery, num: 5 }),
      signal: controller.signal as any,
    });

    if (!res.ok) {
      console.error(`[priceContext] Serper returned HTTP ${res.status}`);
      return null;
    }

    const json: any = await res.json();

    const parts: string[] = [];

    // Answer box (Google's direct answer, e.g. AI Overview or featured snippet)
    const answerBox = json?.answerBox;
    if (answerBox?.answer) {
      parts.push(`Answer: ${answerBox.answer}`);
    } else if (answerBox?.snippet) {
      parts.push(`Answer: ${answerBox.snippet}`);
    }

    // Knowledge graph snippet
    if (json?.knowledgeGraph?.description) {
      parts.push(`Overview: ${json.knowledgeGraph.description}`);
    }

    // Organic results — title + snippet
    const organic: string[] = (json?.organic ?? [])
      .slice(0, 5)
      .map((r: any) => {
        const title = r?.title ? `[${r.title}]` : "";
        const snippet = r?.snippet ?? "";
        return [title, snippet].filter(Boolean).join(" ");
      })
      .filter(Boolean);

    if (organic.length) {
      parts.push(`Results:\n${organic.map((s, i) => `[${i + 1}] ${s}`).join("\n\n")}`);
    }

    if (parts.length === 0) return null;
    return parts.join("\n\n");
  } catch (err: any) {
    if (err?.name === "AbortError") {
      console.warn("[priceContext] Serper request timed out");
    } else {
      console.error("[priceContext] Serper fetch error:", err);
    }
    return null;
  } finally {
    clearTimeout(timer);
  }
}
