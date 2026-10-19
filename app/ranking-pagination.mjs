// Pass directly to page.evaluate(). This is observation only: no clicks,
// navigation, requests, input values, or selectors inferred for later actions.
export function observeRankingPaginationDOM() {
  const LIMIT_CONTAINERS = 4, LIMIT_CONTROLS = 60;
  const normalize = value => String(value || "").replace(/\s+/g, " ").trim();
  const attr = (node, name) => node.getAttribute(name);
  const visible = node => {
    if (!node.getClientRects().length) return false;
    const style = getComputedStyle(node);
    return style.display !== "none" && style.visibility !== "hidden" && style.visibility !== "collapse" && Number(style.opacity || 1) > 0;
  };
  const className = node => normalize(attr(node, "class")).split(" ")
    .filter(token => /^[a-zA-Z0-9_-]{1,80}$/.test(token)).slice(0, 8).join(" ").slice(0, 180);
  // Only whole labels with known pagination meaning are returned. Arbitrary
  // aria-label/title/text values are deliberately omitted, even in a pager.
  const publicLabel = value => {
    const text = normalize(value);
    if (text.length > 80) return null;
    return /^(?:\d{1,7}|[.…]{1,3}|上一页|下一页|首页|尾页|末页|前一页|后一页|分页|页码|分页导航|第\s*\d{1,7}\s*页|(?:前往|跳转到|跳至)\s*第?\s*\d{1,7}\s*页|共\s*[\d,]{1,12}\s*(?:条|项|个|页)(?:数据|记录|结果)?|pagination|pages?|(?:go to |goto )?page\s+\d{1,7}|(?:next|previous|prev|first|last)(?:\s+page)?|total\s+[\d,]{1,12}(?:\s+(?:items?|records?|results?|pages?))?)$/i.test(text) ? text : null;
  };
  const number = text => /^\d{1,7}$/.test(text || "") ? Number(text) : null;
  const containers = [], pageNumbers = new Set(), currentPages = new Set(), totals = new Set();
  let truncated = false;
  const candidates = [...document.querySelectorAll('nav[aria-label], [role="navigation"][aria-label], [class*="pagination"], [class*="Pagination"]')]
    .filter(node => visible(node) && (/pagination/i.test(attr(node, "class") || "") || /pagination|分页|页码/i.test(normalize(attr(node, "aria-label")))));
  const roots = candidates.filter(node => !candidates.some(parent => parent !== node && parent.contains(node)));
  if (roots.length > LIMIT_CONTAINERS) truncated = true;
  for (const root of roots.slice(0, LIMIT_CONTAINERS)) {
    const controls = [];
    const nodes = [...root.querySelectorAll('button, a, li, span, [role="button"], [role="link"], [aria-current], [aria-label], [title]')];
    for (const node of nodes) {
      const tag = node.tagName.toLowerCase();
      if (["input", "textarea", "select", "option", "script", "style"].includes(tag) || !visible(node)) continue;
      const label = publicLabel(attr(node, "aria-label"));
      const title = publicLabel(attr(node, "title"));
      const text = publicLabel(node.innerText);
      const classes = className(node);
      // Preserve the structure of unlabeled pagination arrows for human
      // inspection, without inventing their text or a clickable selector.
      const unlabeledPagerControl = /pagination/i.test(classes) && /(?:^|[-_ ])(?:prev|previous|next)(?:$|[-_ ])/i.test(classes);
      if (!label && !title && !text && !unlabeledPagerControl) continue;
      if (controls.length >= LIMIT_CONTROLS) { truncated = true; break; }
      const rawCurrent = attr(node, "aria-current");
      const ariaCurrent = ["page", "step", "location", "date", "time", "true", "false"].includes(rawCurrent) ? rawCurrent : null;
      const classCurrent = /(?:^|[-_ ])(?:active|current|selected)(?:$|[-_ ])/i.test(classes);
      const current = ariaCurrent && ariaCurrent !== "false" ? true : ariaCurrent === "false" ? false : classCurrent;
      const value = text || label || title;
      const page = number(value) ?? (/^(?:(?:go to |goto )?page\s+|第\s*)(\d{1,7})(?:\s*页)?$/i.exec(value || "")?.[1] ? Number(/\d{1,7}/.exec(value)[0]) : null);
      if (page !== null) { pageNumbers.add(page); if (current) currentPages.add(page); }
      const totalMatch = /^(?:共\s*([\d,]+)\s*(条|项|个|页)(?:数据|记录|结果)?|total\s+([\d,]+)(?:\s+(items?|records?|results?|pages?))?)$/i.exec(value || "");
      const total = totalMatch ? Number((totalMatch[1] || totalMatch[3]).replaceAll(",", "")) : null;
      const totalUnit = totalMatch ? (totalMatch[2] || totalMatch[4] || "unspecified").toLowerCase() : null;
      if (total !== null && Number.isSafeInteger(total)) totals.add(JSON.stringify({value:total,unit:totalUnit}));
      const kind = /^(?:上一页|前一页|previous(?: page)?|prev(?: page)?)$/i.test(value || "") ? "previous"
        : /^(?:下一页|后一页|next(?: page)?)$/i.test(value || "") ? "next"
        : page !== null ? "page" : total !== null ? "total" : "other";
      controls.push({tag,role:["button","link","listitem","navigation"].includes(attr(node,"role")) ? attr(node,"role") : null,
        class:classes,aria_label:label,title,text,kind,page,current:Boolean(current),
        current_evidence:ariaCurrent && ariaCurrent !== "false" ? "aria-current" : ariaCurrent === "false" ? null : classCurrent ? "class" : null,
        disabled:node.hasAttribute("disabled") || attr(node,"aria-disabled") === "true" || /(?:^|[-_ ])disabled(?:$|[-_ ])/i.test(classes),
        ...(total !== null ? {total,total_unit:totalUnit} : {})});
    }
    containers.push({tag:root.tagName.toLowerCase(),role:attr(root,"role") === "navigation" ? "navigation" : null,
      class:className(root),aria_label:publicLabel(attr(root,"aria-label")),controls});
  }
  return {status:containers.some(container => container.controls.length) ? "observed" : "unrecognized",
    container_count:containers.length,containers,visible_page_numbers:[...pageNumbers].sort((a,b)=>a-b),
    current_page_candidates:[...currentPages].sort((a,b)=>a-b),totals:[...totals].map(value=>JSON.parse(value)),truncated};
}
