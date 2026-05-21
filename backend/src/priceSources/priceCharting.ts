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

export type ScrapedPriceChartingItem = {
  url: string;
  title: string;
  grade: number | null;
  loosePrice: number | null;
  completePrice: number | null;
  newPrice: number | null;
  gradedPrice: number | null;
  gradedSalePrices: number[];
  gradedSaleLow: number | null;
  gradedSaleHigh: number | null;
  tcgPlayerPrice: number | null;
  tcgPlayerUrl: string | null;
};

export async function scrapePriceChartingUrl(itemUrl: string, rawTitle?: string): Promise<ScrapedPriceChartingItem> {
  const rawGrade = rawTitle ? extractGrade(rawTitle) : null;
  const gradeConfig = rawGrade !== null ? gradeToConfig(rawGrade) : null;
  const grade = gradeConfig !== null ? rawGrade : null; // ignore grades < 7 (no PC config)

  const res = await fetchPC(itemUrl);
  if (!res.ok) throw new Error(`PriceCharting fetch failed: HTTP ${res.status}`);
  const html = await res.text();
  const $item = load(html);

  const title =
    $item("h1").first().text().trim() ||
    $item("title").first().text().trim() ||
    itemUrl;

  const loosePrice = parsePriceCell($item("#used_price").first().text());
  const completePrice = parsePriceCell($item("#complete_price").first().text());
  const newPrice = parsePriceCell($item("#new_price").first().text());
  const gradedPrice = gradeConfig ? parsePriceCell($item(gradeConfig.priceId).first().text()) : null;

  // Scrape individual sale prices from the graded completed-auctions section.
  // Each sale row has id="ebay-XXXX". The accepted price is the first span.js-price
  // inside td.numeric:not(.listed-price) — this skips the "listed price" shown for
  // best-offer sales where two js-price spans appear.
  let gradedSalePrices: number[] = [];
  let gradedSaleLow: number | null = null;
  let gradedSaleHigh: number | null = null;
  if (gradeConfig) {
    const $section = $item(`.${gradeConfig.fragment}`);
    $section.find("tr[id^='ebay-']").each((_, row) => {
      const priceSpan = $item(row).find("td.numeric:not(.listed-price) span.js-price").first();
      const price = parsePriceCell(priceSpan.text().trim());
      if (price !== null && price >= 0.5) gradedSalePrices.push(price);
    });
    if (gradedSalePrices.length > 0) {
      gradedSaleLow = Math.min(...gradedSalePrices);
      gradedSaleHigh = Math.max(...gradedSalePrices);
    }
  }

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

  const finalUrl = gradeConfig ? `${itemUrl}#${gradeConfig.fragment}` : itemUrl;

  return { url: finalUrl, title, grade, loosePrice, completePrice, newPrice, gradedPrice, gradedSalePrices, gradedSaleLow, gradedSaleHigh, tcgPlayerPrice, tcgPlayerUrl };
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

type CardInfo = { cardName: string; number: string; setName: string };

function normalizePCQuery(raw: string): string | null {
  const cleaned = raw.trim().replace(/\s+/g, " ");
  if (!cleaned) return null;
  return cleaned.replace(/#\s*0*(\d+)/g, "#$1");
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

function buildDirectUrlVariants(cardName: string, numStr: string, setName: string): string[] {
  const isPromo = /[a-z]/i.test(numStr);
  const numSlug = slugifyPC(numStr);
  const numVariants = isPromo
    ? [numSlug]
    : (() => {
        const n = parseInt(numStr, 10);
        return [...new Set([String(n), String(n).padStart(2, "0"), String(n).padStart(3, "0")])];
      })();

  const setSlugAnd = `pokemon-${slugifyPC(setName, "and")}`;
  const setSlugDrop = `pokemon-${slugifyPC(setName, "drop")}`;
  const cardSlug = slugifyPC(cardName);
  const cardSlugNoSuffix = slugifyPC(cardName.replace(/\s+(?:ex|gx|v|vmax|vstar)$/i, "").trim());

  const setVariants = [...new Set([setSlugAnd, setSlugDrop])];
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
- number: The full card identifier as a string. For regular cards strip leading zeros: "023/131" → "23", "125/165" → "125". For promos preserve the full code: "286/SM-P" → "SM286", "SWSH241" → "SWSH241", "SV-P 058" → "SV58". Never include the set total (drop the /165 part).
- setName: The Pokemon TCG set name. For promos use the promo series name e.g. "Sun & Moon Black Star Promos", "Sword & Shield Black Star Promos", "Scarlet & Violet Black Star Promos". For regular sets e.g. "Prismatic Evolutions", "Obsidian Flames", "Surging Sparks".

Return up to 3 candidates. If you're confident, return 1. If the set name or card name is ambiguous, return multiple interpretations. Every candidate MUST have all three fields.

Respond ONLY as JSON: {"candidates":[{"cardName":"Vaporeon EX","number":"23","setName":"Prismatic Evolutions"}]}`,
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
      (typeof (c as any)?.number === "string" || typeof (c as any)?.number === "number") &&
      typeof (c as any)?.setName === "string"
    ).map((c) => ({ cardName: c.cardName, number: String((c as any).number), setName: c.setName }));
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
  const groqCandidates = await extractCardInfoWithGroq(cleanTitle);

  const groqUrls = groqCandidates
    .flatMap((c: CardInfo) => buildDirectUrlVariants(c.cardName, c.number, c.setName))
    .filter((url: string, index: number, all: string[]) => all.indexOf(url) === index);

  debugLines.push(`Groq URLs: ${groqUrls.join(", ") || "none"}`);

  const directUrls = groqUrls.slice(0, 2);
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

  const groqSearchQueries = groqCandidates.map((c: CardInfo) =>
    normalizePCQuery(`${c.cardName} #${c.number} ${c.setName}`)
  ).filter((q: string | null): q is string => !!q);

  const searchCandidates = groqSearchQueries.slice(0, 2);

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
