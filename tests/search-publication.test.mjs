import test from "node:test";
import assert from "node:assert/strict";
import {
  parseSearchCardTail,
  publicationFromText,
  validatePublicationFields,
} from "../app/search-publication.mjs";

test("relative card publication remains visible text and is not appended to the author or inferred as a timestamp", () => {
  const value = parseSearchCardTail(
    ["00:52", "432", "作品标题", "@公开作者", "22小时前"],
    3,
  );
  assert.deepEqual(value, {
    author: "公开作者",
    published_text: "22小时前",
    publication_precision: "relative",
    published_date: null,
  });
  assert.equal(Object.hasOwn(value, "published_at"), false);
  assert.deepEqual(parseSearchCardTail(["@作者", "1天前"], 0), {
    author: "作者",
    published_text: "1天前",
    publication_precision: "relative",
    published_date: null,
  });
});
test("full dates retain calendar-day precision and reject invalid days without inventing a time", () => {
  assert.deepEqual(publicationFromText("2024-02-29"), {
    published_text: "2024-02-29",
    publication_precision: "date",
    published_date: "2024-02-29",
  });
  assert.deepEqual(publicationFromText("2026-02-30"), {
    published_text: "2026-02-30",
    publication_precision: "unknown",
    published_date: null,
  });
  assert.deepEqual(publicationFromText("10-19"), {
    published_text: "10-19",
    publication_precision: "unknown",
    published_date: null,
  });
  assert.equal(parseSearchCardTail(["@作者", "2026-10-19"], 0).author, "作者");
});
test("missing dates and unrelated tail text do not become false publication evidence", () => {
  assert.deepEqual(parseSearchCardTail(["@作者", "公开作者其他信息"], 0), {
    author: "作者",
    published_text: null,
    publication_precision: "unknown",
    published_date: null,
  });
  assert.deepEqual(parseSearchCardTail(["视频标题", "@作者"], 1), {
    author: "作者",
    published_text: null,
    publication_precision: "unknown",
    published_date: null,
  });
  assert.deepEqual(parseSearchCardTail([], 0), {
    author: null,
    published_text: null,
    publication_precision: "unknown",
    published_date: null,
  });
});
test("publication input validation rejects wrong types, invalid precision and inferred dates", () => {
  for (const row of [
    { published_text: 12 },
    { published_text: {} },
    { published_text: "x".repeat(81) },
    { published_text: "1天前", publication_precision: "date" },
    { published_text: "1天前", published_date: "2026-10-18" },
    {
      published_text: "2026-02-30",
      publication_precision: "date",
      published_date: "2026-02-30",
    },
    { published_text: "2026-10-19", published_date: "2026-10-18" },
    { published_text: "2026-10-19", publication_precision: 1 },
    { published_text: "2026-10-19", published_date: 20261019 },
    { publication_precision: "relative" },
    { published_text: "1天前\n其他内容" },
  ])
    assert.throws(() => validatePublicationFields(row));
  assert.deepEqual(validatePublicationFields({}), {
    published_text: null,
    publication_precision: "unknown",
    published_date: null,
  });
});
