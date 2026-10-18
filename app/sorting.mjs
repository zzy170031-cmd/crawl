export function sortRows(rows, mode = "heat_desc") {
  const numeric = (a, b, field, asc = false) => {
    const x = a[field],
      y = b[field];
    if (!Number.isFinite(x)) return Number.isFinite(y) ? 1 : 0;
    if (!Number.isFinite(y)) return -1;
    return asc ? x - y : y - x;
  };
  return [...rows].sort((a, b) => {
    if (mode === "newest")
      return Date.parse(b.collected_at) - Date.parse(a.collected_at);
    const group =
      a.sub_type - b.sub_type ||
      a.date_window - b.date_window ||
      JSON.stringify(a.category_filter ?? null).localeCompare(
        JSON.stringify(b.category_filter ?? null),
      );
    return (
      group ||
      numeric(a, b, "score", mode === "heat_asc") ||
      String(a.source_id).localeCompare(String(b.source_id))
    );
  });
}
