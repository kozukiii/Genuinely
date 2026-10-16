export const SEARCH_PAGINATION_KEY = "search:pagination:v1";

export type SearchPagination = { hasMore: boolean; nextOffset: number; warning?: string | null };

export function readSearchPagination(headers: Pick<Headers, "get">, offset: number): SearchPagination {
  const more = headers.get("X-Search-Has-More");
  const rawOffset = headers.get("X-Search-Next-Offset");
  const nextOffset = Number(rawOffset);
  if ((more !== "true" && more !== "false") || rawOffset === null ||
      !Number.isInteger(nextOffset) || nextOffset < offset || nextOffset > 10000) {
    throw new Error("Search pagination is unavailable. Please try again shortly.");
  }
  const hasMore = more === "true";
  if (hasMore && nextOffset === offset && headers.get("X-Ebay-Search-Status") !== "unavailable") {
    throw new Error("Search did not advance. Please try again.");
  }
  return { hasMore, nextOffset };
}

export function restoreSearchPagination(raw: string | null): SearchPagination | null {
  try {
    const value = JSON.parse(raw ?? "null");
    if (value && typeof value.hasMore === "boolean" && Number.isInteger(value.nextOffset) &&
        value.nextOffset >= 0 && value.nextOffset <= 10000 &&
        (value.warning == null || typeof value.warning === "string")) return value;
  } catch { /* Old or corrupt caches must restart; listing counts are not cursors. */ }
  return null;
}

// A short batch can leave the current page unfinished. Show its newly filled
// slots before advancing, otherwise Next would skip those unseen listings.
export function pageAfterAppend(page: number, previousCount: number, nextCount: number, pageSize: number): number {
  const lastPage = Math.max(1, Math.ceil(nextCount / pageSize));
  return Math.min(previousCount < page * pageSize ? page : page + 1, lastPage);
}
