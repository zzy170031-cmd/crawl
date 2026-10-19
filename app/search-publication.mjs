// Publication evidence comes from visible search-card date text. It is not a
// collection timestamp, and relative labels never become precise instants.
const relative =
  /^(?:刚刚|今天|昨天|前天|\d+\s*(?:秒|分钟|小时|天|周|个?月|年)前)$/;
const fullDate = /^\d{4}-\d{2}-\d{2}$/;
const partialDate = /^\d{1,2}-\d{1,2}$/;
const missing = () => ({
  published_text: null,
  publication_precision: "unknown",
  published_date: null,
});
function calendarDate(value) {
  if (!fullDate.test(value)) return null;
  const [year, month, day] = value.split("-").map(Number);
  if (year < 1000 || month < 1 || month > 12 || day < 1 || day > 31)
    return null;
  const date = new Date(Date.UTC(year, month - 1, day));
  return date.getUTCFullYear() === year &&
    date.getUTCMonth() === month - 1 &&
    date.getUTCDate() === day
    ? value
    : null;
}
export function publicationFromText(value) {
  if (value == null || value === "") return missing();
  if (
    typeof value !== "string" ||
    value.length > 80 ||
    /[\x00-\x1f\x7f]/.test(value)
  )
    throw Error("发布时间原文无效");
  const text = value.trim();
  if (!text) return missing();
  const date = calendarDate(text);
  return {
    published_text: text,
    publication_precision: date
      ? "date"
      : relative.test(text)
        ? "relative"
        : "unknown",
    published_date: date,
  };
}
export function parseSearchCardTail(lines, authorIndex) {
  const line =
    Array.isArray(lines) && Number.isInteger(authorIndex) && authorIndex >= 0
      ? lines[authorIndex]
      : null;
  if (typeof line !== "string" || !line.startsWith("@"))
    return { author: null, ...missing() };
  const candidate = lines
    .slice(authorIndex + 1, authorIndex + 9)
    .find(
      (value) =>
        typeof value === "string" &&
        (relative.test(value.trim()) ||
          fullDate.test(value.trim()) ||
          partialDate.test(value.trim())),
    );
  return { author: line.slice(1).trim(), ...publicationFromText(candidate) };
}
export function validatePublicationFields(row) {
  const parsed = publicationFromText(row.published_text);
  const precision = row.publication_precision ?? parsed.publication_precision;
  if (
    !["unknown", "relative", "date"].includes(precision) ||
    precision !== parsed.publication_precision
  )
    throw Error("发布时间精度与实际原文不符");
  if (
    row.published_date !== undefined &&
    row.published_date !== parsed.published_date
  )
    throw Error("发布日期必须与完整日期原文一致，不能推算相对日期");
  return parsed;
}
