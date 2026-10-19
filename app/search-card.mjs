import { parseSearchCardTail } from "./search-publication.mjs";

// Shared pure parser for collected card text and bridge evidence validation.
export function visibleNumber(text) {
  const m = String(text ?? "")
    .replaceAll(",", "")
    .trim()
    .match(/^(\d+(?:\.\d+)?)(万|亿)?$/);
  return m ? Number(m[1]) * ({ 万: 10000, 亿: 100000000 }[m[2]] || 1) : null;
}
export function videoIdentity(url) {
  try {
    const u = new URL(url);
    if (u.protocol !== "https:" || u.hostname !== "www.douyin.com") return null;
    return u.pathname.match(/^\/video\/(\d{10,25})$/)?.[1] || null;
  } catch {
    return null;
  }
}
export function parseSearchCard(card, observedUrl, at) {
  const id = videoIdentity(card.url);
  if (!id) return null;
  const lines = String(card.text || "")
    .split("\n")
    .map((x) => x.trim())
    .filter(Boolean);
  const duration = lines.findIndex((x) => /^\d{1,2}:\d{2}(?::\d{2})?$/.test(x));
  const author = lines.findIndex((x, i) => i > duration && x.startsWith("@"));
  if (duration < 0 || author < duration + 2) return null;
  const count = visibleNumber(lines[duration + 1]);
  const title = lines
    .slice(duration + 2, author)
    .join(" ")
    .trim();
  if (!title) return null;
  return {
    kind: "video",
    source_id: id,
    source_url: `https://www.douyin.com/video/${id}`,
    observed_url: observedUrl,
    title,
    ...parseSearchCardTail(lines, author),
    like_count: count,
    like_display: count === null ? null : lines[duration + 1],
    metric_precision: /[万亿]/.test(lines[duration + 1])
      ? "rounded"
      : "observed",
    score: null,
    source_rank: null,
    play_count: null,
    collected_at: at,
  };
}
