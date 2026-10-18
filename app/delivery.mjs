import { hash } from "./tasks.mjs";
import { TencentClient } from "./tencent-client.mjs";
import { verifyExport } from "./verify-export.mjs";
export function destination(input) {
  if (
    !input ||
    typeof input.file_id !== "string" ||
    !/^[A-Za-z0-9_-]{4,100}$/.test(input.file_id)
  )
    throw Error("请配置腾讯表格file_id");
  const u = new URL(input.url);
  if (
    u.protocol !== "https:" ||
    u.hostname !== "docs.qq.com" ||
    !u.pathname.startsWith("/sheet/")
  )
    throw Error("交付目标须为腾讯在线表格");
  return { file_id: input.file_id, url: u.origin + u.pathname };
}
export function composeRows(task, plan, evidence) {
  const rows = [
    ["策划环节", "完整创作内容", "游戏结合与素材", "制作说明"],
    [
      task.payload.mode === "A" ? "爆款拆解与改编" : "热点联动",
      plan.meaning,
      plan.game,
      plan.rationale,
    ],
  ];
  for (const [n, idea] of plan.ideas.entries()) {
    rows.push(
      [`方案${n + 1}`, idea.title, idea.bridge, idea.limitations.join("\n")],
      ["开头", idea.hook, "", ""],
      [
        "完整原创文案／台词",
        idea.script,
        "",
        "虚构剧情标注演绎，实际机制按来源核验",
      ],
    );
    for (const s of idea.shots)
      rows.push([s.position, s.text, s.visual, s.sound]);
    rows.push([
      "素材清单",
      idea.materials.join("\n"),
      "素材持有状态由创作者核对",
      "",
    ]);
    for (const t of idea.tiers)
      rows.push([
        t.level + "档",
        t.method,
        t.premises.join("\n"),
        t.viewer_value,
      ]);
  }
  if (task.payload.mode === "A")
    for (const e of evidence.filter((e) => e.role === "hotspot"))
      for (const o of e.analysis?.observations || [])
        rows.push([
          "原片约" + o.time + "秒",
          o.text,
          e.url,
          "实际抽样观察；非逐帧全片",
        ]);
  const links = [];
  for (const e of evidence) {
    if (e.kind === "video" || e.kind === "web") {
      links.push({ row: rows.length, col: 1, url: e.url });
      rows.push([
        e.role === "hotspot"
          ? "热点原片"
          : e.kind === "video"
            ? "游戏参考作品"
            : "游戏资料",
        e.url,
        e.title || "",
        e.coverage
          ? `实际读取：画面抽样；语音自动转写；音乐未读。读取于${e.read_at}`
          : `资料读取于${e.read_at}`,
      ]);
    }
  }
  if (rows.some((row) => row.some((cell) => typeof cell !== "string")))
    throw Error("交付正文类型错误");
  return { rows, links };
}
function cellText(cell) {
  if (!cell) return "";
  if (cell.string_value !== undefined) return cell.string_value;
  if (
    cell.number_value !== undefined ||
    cell.bool_value !== undefined ||
    cell.formula !== undefined
  )
    return Symbol("typed-cell");
  return "";
}
export async function deliver({
  task,
  plan,
  evidence,
  db,
  signal,
  client = new TencentClient(),
  verify = verifyExport,
}) {
  const target = destination(task.payload.destination);
  const draft = composeRows(task, plan, evidence);
  const planHash = hash({ plan, draft });
  const key = "delivery:" + hash({ task: task.id, planHash, target });
  let receipt = db.checkpoint(key) || {
    plan_hash: planHash,
    target,
    stage: "prepared",
    verified_batches: [],
    warnings: [],
  };
  const save = () => db.checkpoint(key, receipt);
  const check = () => signal?.throwIfAborted();
  const call = async (name, args) => {
    check();
    return client.call(name, args);
  };
  const base = { file_id: target.file_id };
  const name =
    (task.payload.mode === "A" ? "爆款" : "热点") +
    "-" +
    plan.game.slice(0, 8) +
    "-" +
    task.id.slice(0, 8) +
    "-" +
    planHash.slice(0, 6);
  const info = await call("sheet_get_sheet_info", base);
  let sheet = receipt.sheet_id
    ? info.sheets?.find((s) => s.sheet_id === receipt.sheet_id)
    : null;
  if (receipt.sheet_id && !sheet) throw Error("交付子表已被删除，停止自动重建");
  if (!receipt.sheet_id) {
    const matches = info.sheets?.filter((s) => s.sheet_name === name) || [];
    if (matches.length > 1) throw Error("发现多个同名子表，请核对");
    sheet = matches[0];
    if (!sheet) {
      receipt.stage = "creating";
      save();
      sheet = await call("sheet_add_sheet", {
        ...base,
        name,
        append_index: true,
      });
    }
    if (!sheet?.sheet_id) throw Error("创建结果未知，重试前会按唯一名称核对");
    receipt.sheet_id = sheet.sheet_id;
    receipt.stage = "created";
    save();
  }
  if (receipt.content_verified_at)
    return {
      ...receipt,
      cached: true,
      verification_scope: "返回首次验证回执，本次未覆盖或重新核验用户修改",
    };
  const args = { ...base, sheet_id: receipt.sheet_id };
  async function read(start, end) {
    const result = await call("sheet_get_cell_data", {
      ...args,
      start_row: start,
      end_row: end,
      start_col: 0,
      end_col: 3,
      return_csv: false,
    });
    if (!Array.isArray(result.cells))
      throw Error("腾讯回读结构不匹配，停止写入");
    return result.cells;
  }
  for (let start = 0; start < draft.rows.length; start += 15) {
    const end = Math.min(draft.rows.length - 1, start + 14);
    const cells = await read(start, end);
    const changes = [];
    for (let r = start; r <= end; r++)
      for (let c = 0; c < 4; c++) {
        const expected = draft.rows[r][c];
        const actual = cellText(cells.find((v) => v.row === r && v.col === c));
        if (actual === expected) continue;
        if (actual !== "" || receipt.verified_batches.includes(start))
          throw Error("腾讯子表出现人工修改，已停止覆盖");
        if (receipt.pending_batch === start)
          throw Error(
            "上次批次写入结果不完整，无法区分人工清空与未写入，请核对后创建新版本",
          );
        changes.push({
          row: r,
          col: c,
          value_type: "STRING",
          string_value: expected,
        });
      }
    if (changes.length) {
      receipt.pending_batch = start;
      save();
      await call("sheet_set_range_value", { ...args, values: changes });
    }
    const written = await read(start, end);
    for (let r = start; r <= end; r++)
      for (let c = 0; c < 4; c++)
        if (
          cellText(written.find((v) => v.row === r && v.col === c)) !==
          draft.rows[r][c]
        )
          throw Error("正文回读不一致，保留恢复记录");
    receipt.pending_batch = null;
    if (!receipt.verified_batches.includes(start))
      receipt.verified_batches.push(start);
    save();
  }
  receipt.stage = "formatting";
  receipt.link_status = "verified";
  receipt.style_status = "unverified";
  receipt.warnings = [];
  save();
  for (const link of draft.links) {
    try {
      await call("sheet_set_link", {
        ...args,
        ...link,
        display_text: link.url,
      });
      const cells = await read(link.row, link.row);
      const c = cells.find((c) => c.row === link.row && c.col === 1);
      const targetURL =
        c?.hyperlink?.url ?? c?.link?.url ?? c?.hyperlink ?? c?.link;
      if (targetURL !== link.url) {
        receipt.link_status = "unverified";
      }
    } catch {
      receipt.link_status = "failed";
    }
  }
  try {
    await call("sheet_set_cell_style", {
      ...args,
      start_row: 0,
      end_row: draft.rows.length - 1,
      start_col: 0,
      end_col: 3,
      font_family: "微软雅黑",
      font_size: 11,
      wrap_text: true,
      vertical_align: "top",
    });
    await call("sheet_set_cell_style", {
      ...args,
      start_row: 0,
      end_row: 0,
      start_col: 0,
      end_col: 3,
      bold: true,
      bg_color: "FFE8EEF0",
    });
    for (let r = 0; r < draft.rows.length; r++) {
      const color = { 低档: "FFE8F3EA", 中档: "FFE8F0FC", 高档: "FFFFEEDF" }[
        draft.rows[r][0]
      ];
      if (color)
        await call("sheet_set_cell_style", {
          ...args,
          start_row: r,
          end_row: r,
          start_col: 0,
          end_col: 3,
          bg_color: color,
        });
    }
    await call("sheet_set_dimension_size", {
      ...args,
      dimensions: [150, 520, 340, 360].map((size, index) => ({
        dimension_type: "col",
        index,
        size,
      })),
    });
  } catch {
    receipt.style_status = "failed";
  }
  // Re-read after link/style mutations as those may change cell values.
  for (let start = 0; start < draft.rows.length; start += 15) {
    const end = Math.min(start + 14, draft.rows.length - 1);
    const cells = await read(start, end);
    for (let r = start; r <= end; r++)
      for (let c = 0; c < 4; c++)
        if (
          cellText(cells.find((v) => v.row === r && v.col === c)) !==
          draft.rows[r][c]
        )
          throw Error("格式处理后正文变化，交付尚未完成");
  }
  let exportResult;
  try {
    const current = await call("sheet_get_sheet_info", base);
    const currentName = current.sheets?.find(
      (s) => s.sheet_id === receipt.sheet_id,
    )?.sheet_name;
    if (!currentName) throw Error("子表身份丢失");
    exportResult = await verify(
      client,
      target.file_id,
      currentName,
      draft,
      signal,
    );
    receipt.export_verification = exportResult;
    receipt.link_status = exportResult.links ? "verified" : "failed";
    receipt.style_status = exportResult.styles ? "verified" : "failed";
  } catch (e) {
    check();
    receipt.warnings.push(
      "导出属性核验未完成：" + String(e.message).slice(0, 100),
    );
  }
  if (exportResult && !exportResult.content)
    throw Error("导出正文不一致，保留记录待核验");
  receipt.content_verified_at = new Date().toISOString();
  receipt.content_status = "verified";
  receipt.stage = "content_verified";
  receipt.url = target.url + "?tab=" + encodeURIComponent(receipt.sheet_id);
  if (receipt.link_status !== "verified")
    receipt.warnings.push("原片URL正文已验证；可点击链接属性尚未验证");
  if (receipt.style_status !== "verified")
    receipt.warnings.push("样式请求结果已记录，导出样式待核验");
  save();
  return receipt;
}
