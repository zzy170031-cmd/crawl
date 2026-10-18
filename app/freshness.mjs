export function freshness(rows, now = Date.now(), staleAfterMs = 7200000) {
  const times = rows
    .map((r) => Date.parse(r.collected_at))
    .filter(Number.isFinite);
  return {
    latest_at: times.length ? new Date(Math.max(...times)).toISOString() : null,
    oldest_at: times.length ? new Date(Math.min(...times)).toISOString() : null,
    stale_count: rows.filter(
      (r) =>
        Number.isFinite(Date.parse(r.collected_at)) &&
        now - Date.parse(r.collected_at) > staleAfterMs,
    ).length,
    unknown_time_count: rows.length - times.length,
    stale_after_ms: staleAfterMs,
  };
}
