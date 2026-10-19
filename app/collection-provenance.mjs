// Request identity is assigned by the local bridge, never supplied by a source
// page. Legacy material remains unattributed rather than being relabelled new.
import { collectionTargets } from "./categories.mjs";
import { persistedSourceErrorCode } from "./source-errors.mjs";
export function collectionProvenance(request, rows) {
  const id = request?.id || null;
  const records = rows.map(row => ({
    ...row,
    is_from_latest_request: Boolean(id && row.collection_request_id === id),
    cache_state: !row.collection_request_id
      ? "unattributed"
      : id && row.collection_request_id === id ? "current" : "historical",
  }));
  const result = request?.state === "fulfilled" ? request.result : null;
  const failures = Array.isArray(result?.failures) ? result.failures : [];
  // Only fulfilled bridge results carry validated pagination. Visiting a page
  // or matching the metadata count alone is never completion evidence.
  const pagination = result?.pagination?.boards?.length ? result.pagination : null;
  const apiPagination = request?.payload.provider === "redfox" ? result?.api_pagination || null : null;
  const selection = apiPagination && Array.isArray(result?.excluded_records) ? {
    retained_count: result.records.length,
    response_count: result.records.length + result.excluded_records.length,
    excluded_counts: result.excluded_records.reduce((counts, row) => {
      const reason = ["non_video", "type_unknown", "duplicate", "sample_limit", "outside_date_range", "category_mismatch", "local_keyword_mismatch", "keyword_mismatch"].includes(row.reason) ? row.reason : "other";
      counts[reason] = (counts[reason] || 0) + 1;
      return counts;
    }, {}),
  } : null;
  let completeness = apiPagination
    ? apiPagination.status === "partial" ? "api_sample_partial" : "api_response_complete"
    : "unverified";
  if (pagination && request.payload.purpose === "hotspots") {
    const expected = collectionTargets(request.payload).map(target=>target.board);
    const actual = new Set(pagination.boards.map(board=>board.board));
    completeness = !failures.length && expected.length === actual.size && expected.every(board=>actual.has(board))
      ? "accessible_pages_complete" : "partial_accessible_pages";
  }
  return {
    records,
    collection: {
      latest_request: request ? {
        id, state: request.state, error: request.error || null,
        error_code: request.state === "failed" ? persistedSourceErrorCode(request.error) : null,
        created_at: request.created_at, updated_at: request.updated_at,
      } : null,
      requested_scope: request ? {
        purpose: request.payload.purpose,
        ...(request.payload.provider === "redfox" ? {provider:"redfox",sort:request.payload.sort,
          update_policy:"T+1",date_semantics:"complete_calendar_days_through_yesterday",timezone:"Asia/Shanghai"} : {}),
        keyword: request.payload.keyword,
        board: request.payload.board ?? null,
        hours: request.payload.hours,
        category: request.payload.category,
      } : null,
      observed_scope: result?.observed_scope || null,
      failures,
      status: !request ? "not_requested"
        : request.state === "fulfilled" ? failures.length || ["partial_accessible_pages", "api_sample_partial"].includes(completeness) ? "partial" : "observed"
        : request.state === "pending" ? "pending" : "failed",
      completeness,
      pagination,
      ...(request?.payload.provider === "redfox" ? {provider:"redfox",api_pagination:apiPagination,
        selection_summary:selection,
        global_completeness:"unknown",source_updated_at:result?.source_updated_at ?? null,
        update_policy:"T+1",data_start_date:result?.observed_scope?.start_date ?? null,
        data_end_date:result?.observed_scope?.end_date ?? null} : {}),
      // Even matched counts do not establish an immutable official full list.
      metadata_total_status: pagination
        ? pagination.boards.some(board=>board.metadata_total_difference !== 0) ? "count_mismatch" : "matched_counts"
        : "unverified",
      returned_source_count: result?.records?.length ?? null,
      displayed_source_count: records.length,
      current_source_count: records.filter(row => row.is_from_latest_request).length,
      historical_source_count: records.filter(row => row.cache_state === "historical").length,
      unattributed_source_count: records.filter(row => row.cache_state === "unattributed").length,
    },
  };
}
