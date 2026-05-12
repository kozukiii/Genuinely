import fetch, { type Response } from "node-fetch";
import { load } from "cheerio";
import OpenAI from "openai";

const groq = new OpenAI({
  apiKey: process.env.GROQ_API_KEY ?? "",
  baseURL: "https://api.groq.com/openai/v1",
});

// Serialises all outbound PriceCharting fetches so concurrent callers queue up
// rather than hammering the server simultaneously. Retries once on 403.
let _pcQueue: Promise<void> = Promise.resolve();

const PC_HEADERS: Record<string, string> = {
  "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/136.0.0.0 Safari/537.36",
  Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
  "Accept-Language": "en-US,en;q=0.9",
};

async function fetchPC(url: string): Promise<Response> {
  let resolveFn!: (r: Response) => void;
  let rejectFn!: (e: unknown) => void;
  const result = new Promise<Response>((res, rej) => { resolveFn = res; rejectFn = rej; });

  const prev = _pcQueue;
  _pcQueue = prev.then(async () => {
    try {
      let res = await fetch(url, { headers: PC_HEADERS, timeout: 10000 });
      if (res.status === 403) {
        await new Promise((r) => setTimeout(r, 1000));
        res = await fetch(url, { headers: PC_HEADERS, timeout: 10000 });
      }
      resolveFn(res);
    } catch (err) {
      rejectFn(err);
    }
  }).catch(() => {});

  return result;
}

function normalizeTcgPlayerUrl(rawHref: string | null): string | null {
  if (!rawHref) return null;
  const absoluteUrl = rawHref.startsWith("//")
    ? `https:${rawHref}`
    : rawHref.startsWith("http")
    ? rawHref
    : new URL(rawHref, "https://www.pricecharting.com").toString();
  try {
    const url = new URL(absoluteUrl);
    const embeddedTarget = url.searchParams.get("u");
    if (embeddedTarget) {
      const decodedTarget = decodeURIComponent(embeddedTarget);
      if (/^https:\/\/www\.tcgplayer\.com\/product\//i.test(decodedTarget)) return decodedTarget;
    }
    if (/^https:\/\/www\.tcgplayer\.com\/product\//i.test(absoluteUrl)) return absoluteUrl;
  } catch { return null; }
  return null;
}

function buildTcgPlayerUrlFromId(text: string): string | null {
  const idMatch =
    text.match(/TCGPlayer\s*ID:\s*(\d+)/i)
    ?? text.match(/tcgplayer\.com\/product\/(\d+)/i)
    ?? text.match(/product%2F(\d+)/i);
  return idMatch ? `https://www.tcgplayer.com/product/${idMatch[1]}/-` : null;
}

function parsePriceCell(text: string): number | null {
  const match = text.replace(/\s+/g, " ").match(/\$?\s*([0-9][0-9,]*(?:\.[0-9]{1,2})?)/);
  if (!match) return null;
  const value = Number.parseFloat(match[1].replace(/,/g, ""));
  if (!Number.isFinite(value) || value <= 0) return null;
  return Math.round(value * 100) / 100;
}

export type PriceChartingListing = {
  itemId: string;
  title: string;
  price: number | null;
  currency: string;
  soldDate?: string;
  condition?: string;
  url?: string;
};

export type PriceChartingResult = {
  query: string;
  lowPrice: number | null;
  highPrice: number | null;
  averagePrice: number | null;
  medianPrice: number | null;
  currency: string | null;
  sampleSize: number;
  total: number | null;
  ignoredCurrencyCount: number;
  listings: PriceChartingListing[];
  priceChartingUrl: string | null;
  tcgPlayerUrl: string | null;
};

export async function fetchPriceChartingData(
  query: string,
  limit = 50,
  _marketplaceId = "EBAY_US"
): Promise<PriceChartingResult> {
  const cleanQuery = query.trim();
  if (!cleanQuery) throw new Error("Missing query");

  const safeLimit = Math.min(Math.max(Math.floor(limit) || 50, 1), 200);

  function buildFallbackCardQuery(input: string): string | null {
    const numberMatch = input.match(/\b(\d{1,4})\s*(?:\/|(?:SM|SV|SWSH|XY|BW|DP|HGSS)[-\s]?P?\b)/i);
    if (!numberMatch) return null;

    const beforeNumber = input.slice(0, numberMatch.index).trim();
    const nameMatch = beforeNumber.match(/\b([A-Za-z][A-Za-z.'-]*(?:\s+(?:ex|EX|GX|V|VMAX|VSTAR))?)\s*$/);
    if (!nameMatch) return null;

    const cardName = nameMatch[1]
      .replace(/\b(ex|gx|v|vmax|vstar)\b/gi, (token) => token.toLowerCase() === "ex" ? "ex" : token.toUpperCase())
      .replace(/\b[a-z]/g, (letter) => letter.toUpperCase());

    const cardNumber = String(Number.parseInt(numberMatch[1], 10));
    if (!cardNumber || cardNumber === "NaN") return null;

    return `${cardName} #${cardNumber}`;
  }

  function normalizePriceChartingCandidate(raw: string): string | null {
    const cleaned = raw.trim().replace(/\s+/g, " ");
    if (!cleaned) return null;
    return cleaned.replace(/#\s*0*(\d+)/g, "#$1");
  }

  async function reformatQueryForPriceCharting(input: string): Promise<string[]> {
    if (!process.env.GROQ_API_KEY) return [];

    try {
      const response = await groq.chat.completions.create({
        model: "llama-3.3-70b-versatile",
        messages: [
          {
            role: "system",
            content: `You are a Pokemon card data extractor. From the input, extract exactly two things:

1. CARD_NAME: The Pokemon's name only. Rules:
   - "ex", "GX", "V", "VMAX", "VSTAR" are ONLY part of the name when they appear AFTER the Pokemon name. Example: "Pikachu ex" = Pikachu ex. "EX Psyduck" = Psyduck.
   - Never include set name, rarity (SIR, IR, SAR, AR), promo info, or any other descriptor.

2. CARD_NUMBER: The card number digits only. May appear as "276/217", "#276", "286/SM-P" etc — extract only the digits before any slash or dash. If none, output none.

Respond in this exact format with nothing else:
CARD_NAME: {name}
CARD_NUMBER: {number}`,
          },
          {
            role: "system",
            content: `Override the previous response format. Return your three best PriceCharting.com search query guesses for the input. Every guess MUST contain a card number in #N format — never omit it.

Rules:
- The first guess should be exactly "{CARD_NAME} #{CARD_NUMBER}" — strip leading zeros from the number. "031/187" becomes "#31". "057/191" becomes "#57". "286/SM-P" becomes "#286".
- The second guess should use the zero-padded form of the number if applicable, e.g. "#057" instead of "#57", or include the set total e.g. "#57/191" or "#057/191".
- The third guess may include the set name alongside the number.
- "ex", "GX", "V", "VMAX", "VSTAR" are part of the name only when they appear after the character name. "Pikachu ex" stays "Pikachu ex"; "EX Psyduck" becomes "Psyduck".
- Never include rarity, condition, grading, or seller terms (SIR, IR, SAR, AR, Holo, NM, PSA, Japanese, English).
- Every guess must have a #number.

Respond only as JSON in this exact shape:
{"queries":["Pikachu ex #57","Pikachu ex #057","Pikachu ex #57 Surging Sparks"]}`,
          },
          { role: "user", content: input },
        ],
        max_tokens: 100,
        temperature: 0,
      });

      const content = response.choices[0]?.message?.content?.trim() || "";
      const jsonMatch = content.match(/\{[\s\S]*\}/);
      const parsed = jsonMatch ? JSON.parse(jsonMatch[0]) : null;
      const queries: unknown[] = Array.isArray(parsed?.queries) ? parsed.queries : [];

      return queries
        .filter((query): query is string => typeof query === "string")
        .map(normalizePriceChartingCandidate)
        .filter((query): query is string => !!query)
        .slice(0, 3);
    } catch {
      return [];
    }
  }

  try {
    const headers: Record<string, string> = {
      "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/136.0.0.0 Safari/537.36",
      Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
      "Accept-Language": "en-US,en;q=0.9",
    };

    const formattedQueries = await reformatQueryForPriceCharting(cleanQuery);
    const fallbackCardQuery = buildFallbackCardQuery(cleanQuery);
    const searchQueries = [...formattedQueries, fallbackCardQuery, cleanQuery]
      .filter((candidate): candidate is string => !!candidate)
      .filter((candidate, index, all) => all.indexOf(candidate) === index);

    let itemUrl: string | null = null;
    let itemHtml: string | null = null;
    let lastSearchError: Error | null = null;

    for (const searchQuery of searchQueries) {
      const searchUrl = `https://www.pricecharting.com/search-products?q=${encodeURIComponent(searchQuery)}&type=prices`;
      const searchRes = await fetch(searchUrl, { headers });
      if (!searchRes.ok) {
        throw new Error(`PriceCharting search failed: HTTP ${searchRes.status} ${searchRes.statusText}`);
      }

      const searchHtml = await searchRes.text();

      if (searchRes.url.includes("/game/")) {
        itemUrl = searchRes.url;
        itemHtml = searchHtml;
        lastSearchError = null;
        break;
      }

      const $search = load(searchHtml);
      const firstHref =
        $search("table#games_table a[href^='/game/']").first().attr("href")
        ?? $search("table.collection-table a[href^='/game/']").first().attr("href")
        ?? $search("td a[href^='/game/']").first().attr("href")
        ?? $search("a[href^='/game/']").not("nav a, header a, footer a").first().attr("href")
        ?? null;

      if (!firstHref) {
        lastSearchError = new Error(`No PriceCharting result found for "${searchQuery}"`);
        continue;
      }

      itemUrl = new URL(firstHref, "https://www.pricecharting.com").toString();
      const itemRes = await fetch(itemUrl, { headers });
      if (!itemRes.ok) {
        throw new Error(`PriceCharting item fetch failed: HTTP ${itemRes.status} ${itemRes.statusText}`);
      }

      itemHtml = await itemRes.text();
      lastSearchError = null;
      break;
    }

    if (!itemUrl || !itemHtml) {
      throw lastSearchError ?? new Error(`No PriceCharting result found for "${cleanQuery}"`);
    }

    const $item = load(itemHtml);
    const baseTitle =
      $item("h1").first().text().trim() ||
      $item("title").first().text().trim() ||
      cleanQuery;

    const loosePrice = parsePriceCell($item("#used_price").first().text());
    const completePrice = parsePriceCell($item("#complete_price").first().text());
    const newPrice = parsePriceCell($item("#new_price").first().text());
    const tcgPlayerRow = $item("tr[data-source-name='TCGPlayer']").first().length
      ? $item("tr[data-source-name='TCGPlayer']").first()
      : $item("tr").filter((_, row) => $item(row).text().includes("TCGPlayer")).first();
    const tcgPlayerPrice = parsePriceCell(tcgPlayerRow.text());
    const rawTcgHrefs = [
      ...tcgPlayerRow.find("a[data-affiliate='TCGPlayer']").map((_, link) => $item(link).attr("href") ?? "").get(),
      ...tcgPlayerRow.find("a").map((_, link) => $item(link).attr("href") ?? "").get(),
      ...$item("a").map((_, link) => $item(link).attr("href") ?? "").get(),
    ].filter((href) => /tcgplayer/i.test(href));
    const tcgPlayerUrl =
      rawTcgHrefs.map(normalizeTcgPlayerUrl).find((url): url is string => !!url)
      ?? buildTcgPlayerUrlFromId($item.text())
      ?? null;

    const comparisonValues = [loosePrice, tcgPlayerPrice].filter((v): v is number => v !== null);
    const values = [loosePrice, completePrice, newPrice].filter((v): v is number => v !== null);

    const average = values.length
      ? values.reduce((sum, v) => sum + v, 0) / values.length
      : null;

    const listings: PriceChartingListing[] = [
      { itemId: `${itemUrl}#used_price`, title: `${baseTitle} - Loose`, price: loosePrice, currency: "USD", condition: "Loose", url: itemUrl },
      { itemId: `${itemUrl}#complete_price`, title: `${baseTitle} - Complete`, price: completePrice, currency: "USD", condition: "Complete", url: itemUrl },
      { itemId: `${itemUrl}#new_price`, title: `${baseTitle} - New`, price: newPrice, currency: "USD", condition: "New", url: itemUrl },
      { itemId: `${itemUrl}#tcgplayer`, title: `${baseTitle} - TCGPlayer`, price: tcgPlayerPrice, currency: "USD", condition: "TCGPlayer", url: tcgPlayerUrl ?? itemUrl },
    ].slice(0, safeLimit);

    return {
      query: cleanQuery,
      lowPrice: comparisonValues.length ? Math.round(Math.min(...comparisonValues) * 100) / 100 : null,
      highPrice: comparisonValues.length ? Math.round(Math.max(...comparisonValues) * 100) / 100 : null,
      averagePrice: average !== null ? Math.round(average * 100) / 100 : null,
      medianPrice: completePrice !== null ? Math.round(completePrice * 100) / 100 : null,
      currency: values.length ? "USD" : null,
      sampleSize: listings.length,
      total: listings.length,
      ignoredCurrencyCount: 0,
      listings,
      priceChartingUrl: itemUrl,
      tcgPlayerUrl,
    };
  } catch (err: any) {
    const message = err instanceof Error ? err.message : String(err);
    throw new Error(`PriceCharting lookup failed for "${cleanQuery}": ${message}`);
  }
}

export type PriceChartingMatchResult = {
  attemptedQueries: string[];
  matchedQuery: string | null;
  url: string | null;
  found: boolean;
  price?: number | null;
  tcgPlayerPrice?: number | null;
  grade?: number | null;
  gradedPrice?: number | null;
  tcgPlayerUrl?: string | null;
  debugLines?: string[];
};

function extractGrade(title: string): number | null {
  const match = title.match(/\b(?:PSA|BGS|CGC|SGC|GMA|CSG)\s*(\d+(?:\.\d+)?)\b/i);
  if (!match) return null;
  const grade = parseFloat(match[1]);
  return isNaN(grade) ? null : grade;
}

function gradeToConfig(grade: number): { fragment: string; priceId: string } | null {
  if (grade >= 10) return { fragment: "completed-auctions-manual-only", priceId: "#manual_only_price" };
  if (grade >= 9)  return { fragment: "completed-auctions-graded",       priceId: "#graded_price" };
  if (grade >= 8)  return { fragment: "completed-auctions-new",          priceId: "#new_price" };
  if (grade >= 7)  return { fragment: "completed-auctions-cib",          priceId: "#complete_price" };
  return null;
}

type CardInfo = { cardName: string; number: number; setName: string };

function normalizePCQuery(raw: string): string | null {
  const cleaned = raw.trim().replace(/\s+/g, " ");
  if (!cleaned) return null;
  return cleaned.replace(/#\s*0*(\d+)/g, "#$1");
}

function buildSetQuery(input: string, cardQuery: string): string | null {
  const afterTotalMatch = input.match(/\b\d+\/\d+\s+([A-Za-z][^/]+?)(?:\s+(?:nm|lp|mp|hp|dmg|psa|bgs|cgc|sgc|graded|holo|foil|rare|secret|ultra|near|mint|english|japanese|lot|pack|sealed|booster|card|cards)\b|$)/i);
  const setName = afterTotalMatch?.[1]?.trim() ?? null;
  if (!setName || setName.length < 4) return null;
  return normalizePCQuery(`${cardQuery} ${setName}`);
}

function expandSearchPadding(query: string, setTotal: string | null): string[] {
  const numMatch = query.match(/#0*(\d+)(?:\/\d+)?/);
  if (!numMatch) return [query];
  const n = Number(numMatch[1]);
  const plain = `#${n}`;
  const padded = `#${String(n).padStart(3, "0")}`;
  const base = query.replace(/#0*(\d+)(?:\/\d+)?/, plain);
  const basePad = query.replace(/#0*(\d+)(?:\/\d+)?/, padded);
  const withTotal = setTotal ? query.replace(/#0*(\d+)(?:\/\d+)?/, `${plain}/${setTotal}`) : null;
  const withTotalPad = setTotal ? query.replace(/#0*(\d+)(?:\/\d+)?/, `${padded}/${setTotal}`) : null;
  return [base, basePad, withTotal, withTotalPad].filter((v): v is string => !!v);
}

function buildFallbackDebugQuery(input: string): string | null {
  const numberMatch = input.match(/\b(\d{1,4})\s*(?:\/|(?:SM|SV|SWSH|XY|BW|DP|HGSS)[-\s]?P?\b)/i);
  if (!numberMatch) return null;

  const beforeNumber = input.slice(0, numberMatch.index).trim();
  const cleanedBeforeNumber = beforeNumber
    .replace(/\b(?:pokemon|pokémon|tcg|sv\d+|scarlet|violet|sword|shield|ultra|rare|secret|hyper|illustration|promo|holo|foil|near|mint|nm|gem|mt|psa|bgs|cgc|sgc|graded|card|cards)\b/gi, " ")
    .replace(/[^\p{L}\p{N}.'\-\s]/gu, " ")
    .replace(/\s+/g, " ")
    .trim();

  const words = cleanedBeforeNumber.split(/\s+/).filter(Boolean);
  const cardNumber = String(Number.parseInt(numberMatch[1], 10));
  if (!cardNumber || cardNumber === "NaN") return null;

  const suffixIndex = words.findIndex((word) => /^(?:ex|gx|v|vmax|vstar)$/i.test(word));
  if (suffixIndex > 0) {
    const start = Math.max(0, suffixIndex - 2);
    const cardName = words.slice(start, suffixIndex + 1).join(" ");
    return `${normalizeCardName(cardName)} #${cardNumber}`;
  }

  const firstNameWord = words.find((word) =>
    /^[\p{L}][\p{L}.'-]*$/u.test(word)
    && !/^(?:with|and|the|a|an|of|museum|van|gogh)$/i.test(word)
  );

  return firstNameWord ? `${normalizeCardName(firstNameWord)} #${cardNumber}` : null;
}

function normalizeCardName(name: string): string {
  return name
    .replace(/\b(ex|gx|v|vmax|vstar)\b/gi, (token) => token.toLowerCase() === "ex" ? "ex" : token.toUpperCase())
    .replace(/\b[a-z]/g, (letter) => letter.toUpperCase());
}

function slugifyPC(text: string, ampersand: "and" | "drop" = "and"): string {
  return text
    .toLowerCase()
    .replace(/&/g, ampersand === "and" ? "and" : "")
    .replace(/[^a-z0-9\s]/g, "")
    .replace(/\s+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "");
}

function buildDirectUrlVariants(cardName: string, n: number, setName: string): string[] {
  const numPlain = String(n);
  const numPad2 = String(n).padStart(2, "0");
  const numPad3 = String(n).padStart(3, "0");
  const setSlugAnd = `pokemon-${slugifyPC(setName, "and")}`;
  const setSlugDrop = `pokemon-${slugifyPC(setName, "drop")}`;
  const cardSlug = slugifyPC(cardName);
  const cardSlugNoSuffix = slugifyPC(cardName.replace(/\s+(?:ex|gx|v|vmax|vstar)$/i, "").trim());

  const setVariants = [...new Set([setSlugAnd, setSlugDrop])];
  const numVariants = [...new Set([numPlain, numPad2, numPad3])];
  const cardVariants = [...new Set([cardSlug, cardSlugNoSuffix])];

  const urls: string[] = [];
  for (const set of setVariants) {
    for (const num of numVariants) {
      for (const card of cardVariants) {
        urls.push(`https://www.pricecharting.com/game/${set}/${card}-${num}`);
        if (urls.length >= 5) return urls;
      }
    }
  }

  return [...new Set(urls)].slice(0, 5);
}

function extractSetName(input: string, cardName: string): string | null {
  const NOISE = /\b(?:nm|lp|mp|hp|dmg|psa|bgs|cgc|sgc|graded|holo|foil|rare|secret|ultra|near|mint|english|japanese|lot|pack|sealed|booster|card|cards|pokemon|pokémon|tcg)\b/gi;

  // Pattern 1: set name after "number/total" — "057/191 Surging Sparks NM"
  const afterMatch = input.match(/\b\d+\/\d+\s+([A-Za-z][^/]+?)(?:\s+(?:nm|lp|mp|hp|dmg|psa|bgs|cgc|sgc|graded|holo|foil|rare|secret|ultra|near|mint|english|japanese|lot|pack|sealed|booster|card|cards)\b|$)/i);
  if (afterMatch) {
    const name = afterMatch[1].trim();
    if (name.length >= 4) return name;
  }

  // Pattern 2: set name before "number/total" — "Charizard ex Obsidian Flames 125/165"
  const numberPos = input.search(/\b\d+\/\d+/);
  if (numberPos > 0) {
    let remaining = input.slice(0, numberPos);
    for (const word of cardName.split(/\s+/)) {
      remaining = remaining.replace(new RegExp(`(?:^|\\s)${word.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?:\\s|$)`, "gi"), " ");
    }
    remaining = remaining.replace(NOISE, " ").replace(/\s+/g, " ").trim();
    if (remaining.length >= 4) return remaining;
  }

  return null;
}

function buildDirectUrlsFromTitle(input: string): string[] {
  const cardQuery = buildFallbackDebugQuery(input);
  if (!cardQuery) return [];

  const parsedCard = cardQuery.match(/^(.+?)\s+#(\d+)$/);
  if (!parsedCard) return [];

  const cardName = parsedCard[1];
  const n = parseInt(parsedCard[2], 10);
  if (isNaN(n)) return [];

  const setName = extractSetName(input, cardName);
  if (!setName) return [];

  return buildDirectUrlVariants(cardName, n, setName);
}

async function extractCardInfoWithGroq(input: string): Promise<CardInfo[]> {
  if (!process.env.GROQ_API_KEY) return [];

  try {
    const response = await groq.chat.completions.create({
      model: "llama-3.3-70b-versatile",
      messages: [
        {
          role: "system",
          content: `You are a Pokemon card data extractor. From the eBay listing title, extract:
- cardName: Pokemon name only. Include suffix (ex, GX, V, VMAX, VSTAR) only when it follows the Pokemon name. Never include set name, rarity, or condition.
- number: Card number as an integer, no leading zeros. "023/131" → 23, "125/165" → 125.
- setName: The Pokemon TCG set name. It may appear before OR after the number. e.g. "Prismatic Evolutions", "Obsidian Flames", "Surging Sparks", "Twilight Masquerade".

Return up to 3 candidates. If you're confident, return 1. If the set name or card name is ambiguous, return multiple interpretations. Every candidate MUST have all three fields.

Respond ONLY as JSON: {"candidates":[{"cardName":"Vaporeon EX","number":23,"setName":"Prismatic Evolutions"}]}`,
        },
        { role: "user", content: input },
      ],
      max_tokens: 200,
      temperature: 0,
    });

    const content = response.choices[0]?.message?.content?.trim() ?? "";
    const jsonMatch = content.match(/\{[\s\S]*\}/);
    const parsed = jsonMatch ? JSON.parse(jsonMatch[0]) : null;
    const candidates: unknown[] = Array.isArray(parsed?.candidates) ? parsed.candidates : [];

    return candidates.filter((c): c is CardInfo =>
      typeof (c as any)?.cardName === "string" &&
      typeof (c as any)?.number === "number" &&
      typeof (c as any)?.setName === "string"
    ).map((c) => ({ cardName: c.cardName, number: Math.round(c.number), setName: c.setName }));
  } catch {
    return [];
  }
}

export async function findPriceChartingMatch(rawTitle: string): Promise<PriceChartingMatchResult> {
  const cleanTitle = rawTitle.trim();
  const debugLines: string[] = [];
  if (!cleanTitle) {
    return { attemptedQueries: [], matchedQuery: null, url: null, found: false, debugLines };
  }

  debugLines.push(`Title: ${cleanTitle}`);

  const grade = extractGrade(cleanTitle);
  debugLines.push(`Grade detected: ${grade ?? "none"}`);

  async function foundResult(matchedUrl: string, matchedQuery: string, attempted: string[], prefetchedHtml?: string): Promise<PriceChartingMatchResult> {
    let loosePrice: number | null = null;
    let gradedPrice: number | null = null;
    let tcgPlayerPrice: number | null = null;
    let tcgPlayerUrl: string | null = null;

    try {
      const html = prefetchedHtml ?? await (async () => {
        const pageRes = await fetchPC(matchedUrl);
        return pageRes.ok ? pageRes.text() : null;
      })();
      if (html) {
        const $page = load(html);
        loosePrice = parsePriceCell($page("#used_price").first().text());
        if (grade !== null) {
          const config = gradeToConfig(grade);
          if (config) gradedPrice = parsePriceCell($page(config.priceId).first().text());
        }
        const tcgRow = $page("tr[data-source-name='TCGPlayer']").first().length
          ? $page("tr[data-source-name='TCGPlayer']").first()
          : $page("tr").filter((_, row) => $page(row).text().includes("TCGPlayer")).first();
        tcgPlayerPrice = parsePriceCell(tcgRow.text());
        const rawTcgHrefs = [
          ...tcgRow.find("a").map((_, a) => $page(a).attr("href") ?? "").get(),
          ...$page("a").map((_, a) => $page(a).attr("href") ?? "").get(),
        ].filter((h) => /tcgplayer/i.test(h));
        tcgPlayerUrl =
          rawTcgHrefs.map(normalizeTcgPlayerUrl).find((u): u is string => !!u)
          ?? buildTcgPlayerUrlFromId(html)
          ?? null;
      }
    } catch { /* best-effort */ }

    debugLines.push(`Loose price: ${loosePrice ?? "not found"}`);
    debugLines.push(`TCGPlayer price: ${tcgPlayerPrice ?? "not found"}`);
    if (grade !== null) debugLines.push(`Graded price: ${gradedPrice ?? "not found"}`);
    debugLines.push(`TCGPlayer URL: ${tcgPlayerUrl ?? "not found"}`);

    const config = grade !== null ? gradeToConfig(grade) : null;
    const finalUrl = config ? `${matchedUrl}#${config.fragment}` : matchedUrl;
    const price = gradedPrice ?? loosePrice;

    return {
      attemptedQueries: attempted,
      matchedQuery,
      url: finalUrl,
      found: true,
      price,
      tcgPlayerPrice,
      tcgPlayerUrl,
      ...(grade !== null && { grade, gradedPrice }),
      debugLines,
    };
  }

  // --- Phase 1: direct URL tries ---
  const [groqCandidates, regexUrls] = await Promise.all([
    extractCardInfoWithGroq(cleanTitle),
    Promise.resolve(buildDirectUrlsFromTitle(cleanTitle)),
  ]);

  const groqUrls = groqCandidates
    .flatMap((c) => buildDirectUrlVariants(c.cardName, c.number, c.setName))
    .filter((url, index, all) => all.indexOf(url) === index);

  debugLines.push(`Groq URLs: ${groqUrls.join(", ") || "none"}`);
  debugLines.push(`Regex URLs: ${regexUrls.join(", ") || "none"}`);

  const directUrls = [...new Set([...groqUrls, ...regexUrls])];
  debugLines.push(`Direct URLs (${directUrls.length}): ${directUrls.join(", ") || "none"}`);

  for (const url of directUrls) {
    try {
      debugLines.push(`Trying direct: ${url}`);
      const res = await fetchPC(url);
      debugLines.push(`Response: HTTP ${res.status}`);
      if (res.ok && res.url.includes("/game/")) {
        debugLines.push(`Match: ${res.url}`);
        const html = await res.text();
        return foundResult(res.url, url, directUrls, html);
      }
    } catch {
      debugLines.push(`Fetch threw: ${url}`);
    }
  }

  // --- Phase 2: search fallback after 2s ---
  debugLines.push("Direct URLs exhausted — waiting 2s before search fallback");
  await new Promise((resolve) => setTimeout(resolve, 2000));

  const fallback = buildFallbackDebugQuery(cleanTitle);
  const setQuery = fallback ? buildSetQuery(cleanTitle, fallback) : null;
  const groqSearchQueries = groqCandidates.map((c) =>
    normalizePCQuery(`${c.cardName} #${c.number} ${c.setName}`)
  ).filter((q): q is string => !!q);

  const setTotalMatch = cleanTitle.match(/\b\d+\/(\d+)\b/);
  const setTotal = setTotalMatch?.[1] ?? null;

  const searchCandidates = [...groqSearchQueries, fallback, setQuery, cleanTitle]
    .filter((q): q is string => !!q)
    .map(normalizePCQuery)
    .filter((q): q is string => !!q)
    .filter((q, i, all) => all.indexOf(q) === i)
    .flatMap((q) => expandSearchPadding(q, setTotal))
    .filter((q, i, all) => all.indexOf(q) === i);

  debugLines.push(`Search candidates (${searchCandidates.length}): ${searchCandidates.join(", ") || "none"}`);

  const allAttempted = [...directUrls, ...searchCandidates];

  for (const candidate of searchCandidates) {
    try {
      const searchUrl = `https://www.pricecharting.com/search-products?q=${encodeURIComponent(candidate)}&type=prices`;
      debugLines.push(`Search: ${candidate}`);
      const res = await fetchPC(searchUrl);
      debugLines.push(`Search response: HTTP ${res.status} -> ${res.url}`);
      if (!res.ok) continue;

      if (res.url.includes("/game/")) {
        const html = await res.text();
        return foundResult(res.url, candidate, allAttempted, html);
      }

      const html = await res.text();
      const $ = load(html);
      const href =
        $("table#games_table a[href^='/game/']").first().attr("href")
        ?? $("table.collection-table a[href^='/game/']").first().attr("href")
        ?? $("td a[href^='/game/']").first().attr("href")
        ?? $("a[href^='/game/']").not("nav a, header a, footer a").first().attr("href")
        ?? null;

      if (href) {
        const url = new URL(href, "https://www.pricecharting.com").toString();
        debugLines.push(`Search match: ${url}`);
        return foundResult(url, candidate, allAttempted);
      }
    } catch {
      debugLines.push(`Search threw: ${candidate}`);
    }
  }

  debugLines.push("PriceCharting found: false");
  return { attemptedQueries: allAttempted, matchedQuery: null, url: null, found: false, debugLines };
}
