const $ = (id) => document.getElementById(id),
  node = (tag, text) => {
    const n = document.createElement(tag);
    n.textContent = text;
    return n;
  };
let token = "",
  working = false;
async function api(path, data) {
  if (!token) token = (await (await fetch("/api/session")).json()).token;
  const r = await fetch(
    path,
    data === undefined
      ? {}
      : {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "x-crawl-token": token,
          },
          body: JSON.stringify(data),
        },
  );
  const result = await r.json();
  if (!r.ok) throw Error(result.error || "请求失败");
  return result;
}
function show(error) {
  $("message").textContent = error.message || error;
}
function scope() {
  const category = $("category").value,
    board = $("board").value ? Number($("board").value) : null;
  if (category !== "all" && board >= 2000) throw Error("行业仅适用于视频榜");
  return {
    keyword: $("query").value.trim(),
    board,
    category,
    hours: Number($("hours").value),
  };
}
function link(title, url) {
  const a = node("a", title);
  a.href = url;
  a.target = "_blank";
  a.rel = "noopener noreferrer";
  return a;
}
async function profile() {
  const game = $("game").value.trim();
  const p = game
    ? await api("/api/game-profile?game=" + encodeURIComponent(game))
    : null;
  $("profile").textContent = p
    ? `${game} · 已建立资料库 · ${p.relevant_video_ids.length} 条相关作品 · ${p.coverage} · 更新 ${p.created_at}`
    : "请先学习目标游戏；首次学习在后台进行，后续选题复用已读材料。";
}
async function load() {
  const s = scope();
  const p = new URLSearchParams({
    board: s.board || "",
    hours: s.hours,
    category: s.category,
    q: s.keyword,
    sort: $("sort").value,
  });
  const data = await api("/api/hotspots?" + p);
  render(data.records);
}
function render(rows) {
  $("list").replaceChildren();
  if (!rows.length)
    $("list").append(
      node("p", "当前范围暂无结果，可主动获取；不代表全站没有内容。"),
    );
  for (const row of rows) {
    const c = node("article", "");
    c.className = "card";
    c.append(
      node(
        "span",
        `${row.kind} · 榜单 ${row.sub_type} · ${row.date_window}小时`,
      ),
      node("h2", row.title || "无标题"),
      node(
        "p",
        `来源热度 ${row.score ?? "未知"} · 播放 ${row.play_count ?? "未知"}`,
      ),
      node(
        "small",
        `${row.author || "话题/搜索词"} · 采集 ${row.collected_at}`,
      ),
    );
    c.append(node("p", "选题后读取实际代表视频，再结合目标游戏生成建议。"));
    if (row.kind === "video")
      c.append(
        link("查看原片", `https://www.douyin.com/video/${row.source_id}`),
      );
    const mode = document.createElement("select");
    mode.append(new Option("热点联动", "B"), new Option("爆款拆解与改编", "A"));
    const format = document.createElement("select");
    format.append(
      new Option("视频策划", "video"),
      new Option("图文策划", "image"),
    );
    const button = node("button", "确定选题并生成到腾讯文档");
    button.onclick = async () => {
      button.disabled = true;
      try {
        await api("/api/creative-jobs", {
          game: $("game").value.trim(),
          source_id: row.source_id,
          kind: row.kind,
          mode: mode.value,
          format: format.value,
        });
        show("任务已创建，可在进度区查看或取消。");
        await jobs();
      } catch (e) {
        show(e);
      } finally {
        button.disabled = false;
      }
    };
    c.append(mode, format, button);
    $("list").append(c);
  }
}
async function jobs() {
  const tasks = await api("/api/tasks");
  $("jobs").replaceChildren();
  if (tasks.length) $("jobs").append(node("h2", "学习与创作进度"));
  for (const t of tasks) {
    const card = node("article", "");
    card.className = "proposal";
    card.append(
      node(
        "strong",
        `${t.payload.game} · ${t.type === "learn" ? "游戏学习" : t.payload.source?.title} · ${t.state_label}`,
      ),
      node("p", t.stage),
    );
    if (t.error) card.append(node("p", t.error));
    if (t.result?.plan) {
      const p = t.result.plan;
      card.append(node("p", p.meaning), node("p", p.rationale));
      for (const idea of p.ideas)
        card.append(node("strong", idea.title), node("p", idea.bridge));
    }
    if (t.result?.delivery) {
      card.append(link("打开完整腾讯策划", t.result.delivery.url));
      for (const w of t.result.delivery.warnings || [])
        card.append(node("small", w));
    }
    for (const [action, label] of ["queued", "running"].includes(t.state)
      ? [["cancel", "取消"]]
      : ["failed", "needs_input", "cancelled"].includes(t.state)
        ? [["retry", "补充条件后重试"]]
        : []) {
      const b = node("button", label);
      b.onclick = () =>
        api(`/api/tasks/${t.id}/${action}`, {}).then(jobs).catch(show);
      card.append(b);
    }
    $("jobs").append(card);
  }
}
async function subscriptions() {
  const data = await api("/api/subscriptions");
  $("subscriptions").replaceChildren();
  for (const s of data) {
    const p = node(
      "p",
      `榜单${s.board} / ${s.hours}小时 / 行业${s.category} · ${s.last_status || "待采集"} · 下次${s.next_at} ${s.last_error || ""}`,
    );
    const b = node("button", s.enabled ? "停用" : "启用");
    b.onclick = () =>
      api("/api/subscriptions", { ...s, enabled: !s.enabled })
        .then(subscriptions)
        .catch(show);
    p.append(b);
    $("subscriptions").append(p);
  }
}
async function learning(force) {
  await api("/api/game-research", { game: $("game").value.trim(), force });
  show("游戏学习任务已提交；不会把标题采样当成完成。");
  await jobs();
}
$("learn").onclick = () => learning(false).catch(show);
$("relearn").onclick = () => learning(true).catch(show);
$("game").onchange = () => {
  localStorage.setItem("crawl-game", $("game").value);
  profile().catch(show);
};
$("save-settings").onclick = () =>
  api("/api/settings", {
    destination: {
      file_id: $("file-id").value.trim(),
      url: $("doc-url").value.trim(),
    },
  })
    .then(() => show("交付位置已保存"))
    .catch(show);
async function search() {
  if (working) return;
  working = true;
  $("search").disabled = true;
  show("正在获取所选范围…");
  try {
    const s = scope();
    const result = await api("/api/search", s);
    show(result.scope + (result.failures.length ? "；部分榜单失败" : ""));
    await load();
  } catch (e) {
    show(e);
  } finally {
    working = false;
    $("search").disabled = false;
  }
}
$("search").onclick = search;
$("local").onclick = () => load().catch(show);
$("query").onkeydown = (e) => {
  if (e.key === "Enter") search();
};
$("category").onchange = () => {
  if ($("category").value !== "all" && Number($("board").value) >= 2000)
    $("board").value = "";
  search();
};
$("sort").onchange = () => load().catch(show);
$("subscribe").onclick = async () => {
  try {
    await api("/api/subscriptions", { ...scope(), enabled: true });
    show("该榜单范围已加入每小时刷新，关键词不作为订阅过滤条件。");
    await subscriptions();
  } catch (e) {
    show(e);
  }
};
try {
  $("game").value = localStorage.getItem("crawl-game") || "";
  const [directory, settings] = await Promise.all([
    api("/api/categories"),
    api("/api/settings"),
  ]);
  for (const c of directory.categories)
    $("category").append(new Option(c.label, String(c.value)));
  if (settings.destination) {
    $("file-id").value = settings.destination.file_id;
    $("doc-url").value = settings.destination.url;
  }
  await Promise.all([load(), profile(), jobs(), subscriptions()]);
} catch (e) {
  show(e);
}
setInterval(() => {
  if (!document.hidden)
    Promise.all([jobs(), profile(), subscriptions()]).catch(show);
}, 5000);
