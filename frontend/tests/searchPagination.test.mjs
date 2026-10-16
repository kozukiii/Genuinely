import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import ts from "typescript";
// Use the project's existing compiler so these tests need no extra test dependency
// or a Node binary built with experimental TypeScript support.
const source = readFileSync(new URL("../src/utils/searchPagination.ts", import.meta.url), "utf8");
const compiled = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.ESNext } }).outputText;
const { pageAfterAppend, readSearchPagination, restoreSearchPagination } = await import(`data:text/javascript;base64,${Buffer.from(compiled).toString("base64")}`);
const headers = (more, offset, status = "ok") => new Headers({
  "X-Search-Has-More": String(more), "X-Search-Next-Offset": String(offset), "X-Ebay-Search-Status": status,
});
test("short and empty filtered batches remain pageable using the source cursor", () => {
  assert.deepEqual(readSearchPagination(headers(true, 250), 0), { hasMore: true, nextOffset: 250 });
});
test("source exhaustion is explicit, including a full final batch", () => {
  assert.deepEqual(readSearchPagination(headers(false, 12), 0), { hasMore: false, nextOffset: 12 });
});
test("source failures permit retry but successful non-advancing cursors are rejected", () => {
  assert.deepEqual(readSearchPagination(headers(true, 50, "unavailable"), 50), { hasMore: true, nextOffset: 50 });
  assert.throws(() => readSearchPagination(headers(true, 50), 50));
  assert.throws(() => readSearchPagination(headers(true, 40), 50));
  assert.throws(() => readSearchPagination(new Headers(), 0));
});
test("navigation/reload restores continuation and genuinely exhausted states", () => {
  for (const hasMore of [true, false]) {
    const state = { hasMore, nextOffset: 72 };
    assert.deepEqual(restoreSearchPagination(JSON.stringify(state)), state);
  }
});
test("old, corrupt, and invalid caches require a fresh search", () => {
  for (const raw of [null, "{", "{}", '{"hasMore":true,"nextOffset":-1}', '{"hasMore":true,"nextOffset":1.2}']) {
    assert.equal(restoreSearchPagination(raw), null);
  }
});
test("cached source warnings survive hydration without becoming end-of-results claims", () => {
  const state = { hasMore: false, nextOffset: 0, warning: "Marketplace is temporarily unavailable." };
  assert.deepEqual(restoreSearchPagination(JSON.stringify(state)), state);
});

test("refilling a short first batch does not skip newly filled page-one slots", () => {
  assert.equal(pageAfterAppend(1, 3, 15, 12), 1);
  assert.equal(pageAfterAppend(1, 0, 12, 12), 1);
  assert.equal(pageAfterAppend(1, 12, 24, 12), 2);
  assert.equal(pageAfterAppend(2, 15, 27, 12), 2);
  assert.equal(pageAfterAppend(1, 12, 12, 12), 1);
});
