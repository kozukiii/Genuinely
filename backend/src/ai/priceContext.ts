import fetch from "node-fetch";
import dotenv from "dotenv";

dotenv.config({ quiet: true });

const TAVILY_URL = "https://api.tavily.com/search";
const TIMEOUT_MS = 6000;

export async function fetchMarketContext(query: string): Promise<string | null> {
  const apiKey = process.env.TAVILY_API_KEY;
  if (!apiKey) {
    console.warn("[priceContext] TAVILY_API_KEY not set — skipping market context");
    return null;
  }

  const tavilyQuery = `${query} current market price used resale value 2025`;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);

  try {
    const res = await fetch(TAVILY_URL, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        api_key: apiKey,
        query: tavilyQuery,
        search_depth: "basic",
        include_answer: true,
        max_results: 3,
        include_domains: [
          "ebay.com",
          "tcgplayer.com",
          "pricecharting.com",
          "stockx.com",
          "swappa.com",
          "mercari.com",
          "craigslist.org",
          "facebook.com",
        ],
      }),
      signal: controller.signal as any,
    });

    if (!res.ok) {
      console.error(`[priceContext] Tavily returned HTTP ${res.status}`);
      return null;
    }

    const json: any = await res.json();
    const answer: string = json?.answer ?? "";
    const snippets: string[] = (json?.results ?? [])
      .slice(0, 3)
      .map((r: any) => r?.content ?? "")
      .filter(Boolean);

    if (!answer && snippets.length === 0) return null;

    const parts: string[] = [];
    if (answer) parts.push(`Summary: ${answer}`);
    if (snippets.length) parts.push(`Sources:\n${snippets.map((s, i) => `[${i + 1}] ${s}`).join("\n\n")}`);

    return parts.join("\n\n");
  } catch (err: any) {
    if (err?.name === "AbortError") {
      console.warn("[priceContext] Tavily request timed out");
    } else {
      console.error("[priceContext] Tavily fetch error:", err);
    }
    return null;
  } finally {
    clearTimeout(timer);
  }
}
