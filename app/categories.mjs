import { readFileSync } from "node:fs";
const data = JSON.parse(
  readFileSync(new URL("./categories.json", import.meta.url), "utf8"),
);
export const categories = data.categories;
export function resolveCategory(id) {
  if (!id || id === "all") return null;
  if (id === "food-tutorial") id = "628/62804";
  if (!/^\d+(\/\d+)?$/.test(String(id))) throw Error("行业标识无效");
  const [parent, child] = String(id).split("/").map(Number);
  const p = categories.find((c) => c.value === parent);
  if (!p) throw Error("行业不存在，请刷新行业目录。");
  const c =
    child !== undefined ? p.children?.find((c) => c.value === child) : null;
  if (child !== undefined && !c) throw Error("子行业不存在。");
  return {
    id: c ? `${parent}/${child}` : String(parent),
    label: c ? `${p.label} / ${c.label}` : p.label,
    tags: [{ value: parent, ...(c ? { children: [{ value: child }] } : {}) }],
  };
}
export function categoryId(tags) {
  if (!tags?.length) return "all";
  const p = tags[0];
  return p.children?.length
    ? `${p.value}/${p.children[0].value}`
    : String(p.value);
}
export function categoryMatches(tags, id) {
  if (!id) return true;
  if (id === "all") return !tags?.length;
  const target = resolveCategory(id).tags[0];
  return (
    tags?.some(
      (p) =>
        p.value === target.value &&
        (!target.children ||
          p.children?.some((c) => c.value === target.children[0].value)),
    ) || false
  );
}
export function categoryLabel(tags) {
  try {
    return resolveCategory(categoryId(tags))?.label || "不限行业";
  } catch {
    return "未知分类";
  }
}
export function collectionTargets(input) {
  const category = resolveCategory(input.category)?.id || "all";
  const hours = Number(input.hours || 24);
  if (![1, 24, 72, 168].includes(hours)) throw Error("时间窗口无效");
  const ids = [1001, 1002, 1003, 1004, 1005, 2001, 2002, 3001, 3002];
  const board = input.board == null ? null : Number(input.board);
  if (board !== null && !ids.includes(board)) throw Error("榜单无效");
  if (category !== "all" && board >= 2000) throw Error("行业仅适用于视频榜");
  return (
    board ? [board] : ids.filter((id) => category === "all" || id < 2000)
  ).map((board) => ({ board, hours, category }));
}
