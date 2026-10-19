import { matchesObservedVideoScope } from "./observed-ranking-identities.mjs";

const positiveInteger = value => Number.isSafeInteger(value) && value > 0;
const fail = message => { throw Error(message); };

// The caller must pass only receipts owned by this one navigation/click round.
// A page number does not establish round identity: this helper cannot recover
// that provenance from a pooled history of network responses. It performs no
// requests, DOM operations, pagination inference, or cross-page aggregation.
export function observedRankingPageReceipts(receipts, target, expectedChildIds, expectedPage) {
  if (!positiveInteger(expectedPage)) fail("预期榜单页码必须为正整数");
  if (!Array.isArray(receipts) || receipts.length > 64) fail("本轮榜单收据集合无效或超过核验上限");
  const matching = receipts.filter(receipt => receipt &&
    matchesObservedVideoScope(receipt, target, expectedChildIds) && receipt.request.page === expectedPage);
  if (!matching.length) fail("未取得本轮当前范围及指定页码的榜单响应");

  let metadata = null, actualCount = null;
  for (const receipt of matching) {
    if (receipt.status !== 200 || receipt.body?.code !== 0)
      fail("指定页码的榜单响应未成功，不能作为有效页或空结果");
    const page = receipt.body?.data?.page;
    const requestSize = receipt.request.page_size;
    if (!page || Array.isArray(page) || !positiveInteger(page.page) || page.page !== expectedPage ||
        !positiveInteger(requestSize) || requestSize > 1000 ||
        !positiveInteger(page.page_size) || page.page_size !== requestSize ||
        !Number.isSafeInteger(page.total) || page.total < 0)
      fail("请求与响应的分页字段不一致或不可核验");
    const rows = receipt.body?.data?.objs;
    if (!Array.isArray(rows) || rows.length > page.page_size || rows.length > page.total ||
        (page.total === 0 && page.page !== 1))
      fail("指定页码的实际条数与分页字段不一致");
    const current = {page:page.page,page_size:page.page_size,total:page.total};
    if (metadata && (metadata.page !== current.page || metadata.page_size !== current.page_size || metadata.total !== current.total))
      fail("同轮同页的分页元数据冲突，未合并不同版本");
    if (actualCount !== null && actualCount !== rows.length)
      fail("同轮同页的实际条数发生变化，未选择任意版本");
    metadata = current;
    actualCount = rows.length;
  }
  // actual_count < page_size is retained as a measured difference. It does not
  // imply a final page, reachable total, complete board, or permission limit.
  return {receipts:[...matching],metadata,actual_count:actualCount};
}
