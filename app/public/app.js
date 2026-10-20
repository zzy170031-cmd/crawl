const $ = (id) => document.getElementById(id);
const el = (tag, text = "", cls = "") => {
  const n = document.createElement(tag);
  n.textContent = String(text ?? "");
  if (cls) n.className = cls;
  return n;
};
let token = "",
  tokenRequest,
  page = "discover",
  sourceMode = "game",
  gameSourceMode = "game",
  hotspotView = "board";
let records = [],
  recordCollection = null,
  tasks = [],
  bridge = null,
  readiness = null,
  currentProfile = null,
  activeRow = null,
  activeTaskId = null;
let taskDetailSignature = "",
  nextSyncAt = 0;
let listGeneration = 0,
  gameGeneration = 0,
  learningBusy = false,
  searchBusy = false,
  hotspotSearchBusy = false,
  polling = false;
let destination = null;
let candidateDeliveries = [];
let sourceProviders = {game:"browser",hotspots:"browser"};
let qualityCapabilities = null;
let localUploadController = null, localUploadNotice = "";
const redfoxMode = () => sourceProviders.game === "redfox" && sourceProviders.hotspots === "redfox";
let materialHistory = false,
  materialClosing = false,
  cardSignature = "";
// A reload must not leave a stale modal entry in browser history.
if (history.state?.crawlMaterial) history.replaceState(null, "");
const localRead = (key, fallback) => {
  try {
    return JSON.parse(localStorage.getItem(key)) ?? fallback;
  } catch {
    return fallback;
  }
};
let pools = localRead("crawl-saved-pools-v2", {});
if (!pools || typeof pools !== "object" || Array.isArray(pools)) pools = {};
function game() {
  return $("target-game").value.normalize("NFKC").trim();
}
function rememberGame() {
  try {
    localStorage.setItem("crawl-game", game());
  } catch {
    /* storage may be disabled */
  }
}
const learningSourceChoices=new Map();
function learningSource(target=game()) {
  if(learningSourceChoices.has(target))return learningSourceChoices.get(target);
  const value=localRead("crawl-learning-source:"+target,"network");
  const selected=value==="local"?"local":"network";
  learningSourceChoices.set(target,selected);return selected;
}
function rememberLearningSource() {
  const target=game(),value=$("learning-source").value;
  if(!target||!["network","local"].includes(value))return;
  learningSourceChoices.set(target,value);
  try{localStorage.setItem("crawl-learning-source:"+target,JSON.stringify(value));}catch{}
  // A preference change never fetches media or starts a model/query.
}
function safeURL(value) {
  try {
    const url = new URL(value);
    return ["https:", "http:"].includes(url.protocol) ? url.href : null;
  } catch {
    return null;
  }
}
function link(label, value, cls = "source-link") {
  const url = safeURL(value);
  if (!url) return el("span", "来源链接无效", "muted");
  const a = el("a", label, cls);
  a.href = url;
  a.target = "_blank";
  a.rel = "noopener noreferrer";
  return a;
}
function button(label, action, cls = "secondary") {
  const b = el("button", label, cls);
  b.type = "button";
  b.onclick = async () => {
    b.disabled = true;
    try {
      await action();
    } catch (error) {
      show(error, true);
    } finally {
      b.disabled = false;
    }
  };
  return b;
}
let messageTimer;
function show(value, error = false) {
  clearTimeout(messageTimer);
  $("message").textContent = value?.message || String(value ?? "");
  $("message").classList.toggle("error", error);
  if (!error)
    messageTimer = setTimeout(() => {
      $("message").textContent = "";
    }, 8000);
}
async function api(path, data, retrySession = true) {
  if (!token) {
    tokenRequest ??= fetch("/api/session")
      .then(async (r) => {
        if (!r.ok) throw Error("无法连接本地服务");
        return r.json();
      })
      .then((v) => {
        token = v.token;
      })
      .finally(() => {
        tokenRequest = null;
      });
    await tokenRequest;
  }
  const response = await fetch(
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
  const value = await response.json();
  if (!response.ok) {
    if (response.status === 403) token = "";
    // This rejection occurs before the server executes a mutation. Renew the
    // local session once after a service restart without duplicating actions.
    if (response.status === 403 && value.error === "会话过期，请刷新" && retrySession)
      return api(path, data, false);
    if (value.code === "CONNECTIONS_NOT_READY") {
      readiness = value.readiness;
      renderReadiness();
    }
    throw Error(value.error || `请求失败 (${response.status})`);
  }
  return value;
}
async function uploadLocalVideos(files) {
  if(localUploadController || !files.length)return;
  const target=game();
  if(!target)throw Error("请先输入目标游戏，再上传视频。");
  if(files.length>20)throw Error("每次最多选择20个视频；可以分批上传。");
  if(files.some(file=>file.size<=0||file.size>1024*1024*1024))throw Error("单个视频须大于0字节且不超过1GB。");
  const controller=new AbortController();localUploadController=controller;
  const status=$("local-upload-status");status.hidden=false;
  $("cancel-local-upload").hidden=false;$("upload-local-video").disabled=true;
  let saved=0,reused=0;
  try{
    await api("/api/local-videos?game="+encodeURIComponent(target));
    for(let index=0;index<files.length;index++){
      controller.signal.throwIfAborted();
      const file=files[index];
      status.textContent=`正在向「${target}」上传 ${index+1}/${files.length}：${file.name}；文件只保存到本机。`;
      const params=new URLSearchParams({game:target,filename:file.name});
      const response=await fetch("/api/local-videos?"+params,{method:"POST",headers:{"x-crawl-token":token,"Content-Type":file.type||"application/octet-stream"},body:file,signal:controller.signal});
      const value=await response.json();
      if(!response.ok){if(response.status===403)token="";throw Error(value.error||"上传未完成");}
      if(value.record?.duplicate)reused++;else saved++;
    }
    status.textContent=`「${target}」已保存 ${saved} 条新视频，复用 ${reused} 条重复文件。未调用红狐，未自动开始学习。`;
  }catch(error){
    status.textContent=`${controller.signal.aborted?"已停止上传":error.message}。已确认保存 ${saved} 条、复用 ${reused} 条；未确认的文件请刷新列表核对，不会自动重试。`;
    if(!controller.signal.aborted)show(error,true);
  }finally{
    localUploadController=null;$("cancel-local-upload").hidden=true;
    $("upload-local-video").disabled=!game();
    if(game()===target && sourceMode==="game")await loadRecords();
  }
}
const date = (value) =>
  value
    ? new Date(value).toLocaleString("zh-CN", {
        timeZone: "Asia/Shanghai",
        hour12: false,
      })
    : "未记录";
const rowKey = (row) => `${row.kind}:${row.source_id}`;
const pool = () => (Array.isArray(pools[game()]) ? pools[game()] : []);
const automaticSearch = () => bridge?.search_mode === "automatic" || bridge?.collector?.mode === "automatic";
let readinessBusy = false, loginFinishing = false, readinessEntered = false, readinessError = "", lastReadinessCheck = 0;
const confirmedConnections = new Set();
const confirmationRequestedAt = new Map();
let confirmingSite = null;
let pendingDestination = false;
const allConnectionsConfirmed = () => redfoxMode()
  ? Boolean(readiness?.collection_ready && readiness?.redfox?.games?.configured && readiness?.redfox?.hotspots?.configured)
  : Boolean(!pendingDestination && readiness?.ready && confirmedConnections.size === 3);
const verifiedConnectionCount = () => (readiness?.sites || []).filter(site => site.state === "ready" && confirmedConnections.has(site.id)).length;
function renderReadiness() {
  if (!automaticSearch()) return;
  const dialog = $("readiness-dialog");
  const failed = readiness?.sites?.some((site) => (!redfoxMode() || site.id !== "tencent") && ["login_required", "verification_required", "configuration_required", "needs_config", "failed"].includes(site.state));
  if (readinessEntered !== "local" && (!readinessEntered || failed || (!(redfoxMode() ? readiness?.collection_ready : readiness?.ready) && !readiness?.checking)) && !dialog.open) dialog.showModal();
  if (readinessEntered && allConnectionsConfirmed() && dialog.open) dialog.close();
  $("readiness-check").disabled = readinessBusy;
  $("refresh-state").disabled = readinessBusy;
  $("readiness-check").textContent = readinessBusy ? "正在刷新…" : "刷新状态";
  if (redfoxMode()) {
    $("readiness-dialog").querySelector("h2 + p").textContent = "配置红狐 API 后可查询素材；腾讯文档链接在交付前确认。只有点击开始查询才调用收费搜索。";
    for (const old of ["douyin", "douhot"]) $("readiness-site-" + old)?.remove();
    const info = readiness?.redfox;
    const configured = Boolean(info?.games?.configured && info?.hotspots?.configured);
    if (configured) confirmedConnections.add("redfox"); else confirmedConnections.delete("redfox");
    let row = $("readiness-site-redfox");
    if (!row) {
      row = el("section", "", "notice"); row.id = "readiness-site-redfox";
      const title = el("strong"); title.id = "redfox-status-title";
      const detail = el("p"); detail.id = "redfox-status-detail";
      const form = el("form");
      const label = el("label", "红狐 API 密钥", "field");
      const input = document.createElement("input"); input.type = "password"; input.autocomplete = "off"; input.maxLength = 512; input.placeholder = "已配置时无需重复填写"; input.id = "redfox-api-key";
      label.append(input);
      const save = el("button", "保存并确认配置", "secondary"); save.type = "submit";
      form.append(label,save);
      form.onsubmit = async event => {
        event.preventDefault(); save.disabled = true; readinessError = "";
        try {
          if (input.value.trim()) {
            const value = input.value.trim(); input.value = "";
            await api("/api/readiness/redfox-credential", {token:value});
          } else await api("/api/readiness/check", {sites:["douyin","douhot"]});
          await refreshStatus();
        } catch(error) { input.value = ""; readinessError = error.message; }
        finally { save.disabled = false; renderReadiness(); }
      };
      row.append(title,detail,form); $("readiness-sites").prepend(row);
    }
    $("redfox-status-title").textContent = `红狐 API · ${configured ? "密钥已配置" : "需要配置"}`;
    const verified = info?.games?.live_verified || info?.hotspots?.live_verified;
    $("redfox-status-detail").textContent = configured
      ? verified ? "已有成功查询记录；新查询仍以接口实际返回为准。" : "密钥保存在本机后台；未进行收费查询验证。点击开始查询后核验接口。"
      : "填写红狐密钥后保存；状态检查不消耗查询积分。";
  }
  const names = { douyin: "抖音", douhot: "抖音热点宝", tencent: "腾讯文档" };
  const labels = { ready: "已连接", checking: "检查中", login_required: "需要登录", verification_required: "需要验证", needs_config: "需要配置", configuration_required: "需要配置", failed: "连接失败", unchecked: "尚未检查", unknown: "尚未检查" };
  for (const id of (redfoxMode() ? ["tencent"] : ["douyin", "douhot", "tencent"])) {
    const site = readiness?.sites?.find((s) => s.id === id) || { state: "unchecked" };
    const requested = confirmationRequestedAt.get(id);
    if (requested && !(id === "tencent" && pendingDestination) && Date.parse(site.checked_at || "") >= requested) {
      if (site.state === "ready") confirmedConnections.add(id);
      if (site.state !== "checking") confirmationRequestedAt.delete(id);
    }
    if (["login_required", "verification_required", "configuration_required", "failed"].includes(site.state)) confirmedConnections.delete(id);
    let row = document.getElementById("readiness-site-" + id);
    if (!row) {
      row = el("section", "", "notice"); row.id = "readiness-site-" + id;
      row.append(el("strong"), el("p"));
      if (id === "tencent") {
        const form = el("form"); form.id = "readiness-destination-form";
        const label = el("label", "需要操作的腾讯文档链接", "field");
        const input = document.createElement("input"); input.id = "readiness-doc-url"; input.type = "url"; input.required = true; input.placeholder = "https://docs.qq.com/sheet/…"; input.value = destination?.url || "";
        label.append(input);
        const save = el("button", "确认文档连接", "secondary"); save.type = "submit";
        const status = el("p"); status.id = "readiness-destination-status"; status.setAttribute("role", "status");
        form.append(label, save, status);
        form.onsubmit = async (event) => {
          event.preventDefault(); if (pendingDestination) return;
          pendingDestination = true; save.disabled = true; confirmedConnections.delete(id); confirmationRequestedAt.set(id, Date.now()); renderReadiness();
          try {
            const result = await api("/api/settings", {destination: {url: input.value.trim()}});
            destination = result.destination; $("doc-url").value = destination.url;
            status.textContent = "文档链接已保存，正在核验已有授权和文档访问权限。";
            if (result.readiness) { readiness = result.readiness; renderReadiness(); }
          } catch (error) { confirmationRequestedAt.delete(id); status.textContent = error.message; }
          finally { pendingDestination = false; save.disabled = false; renderReadiness(); }
        };
        row.append(form);
      }
      else {
        const actions = el("div", "", "login-links");
        actions.append(button("打开登录 / 验证", () => connectCollector(id)));
        const confirm = el("button", "确认连接", "secondary"); confirm.type = "button";
        confirm.onclick = () => confirmConnection(id); confirm.id = "confirm-" + id;
        actions.append(confirm); row.append(actions);
      }
      $("readiness-sites").append(row);
    }
    row.querySelector("strong").textContent = `${names[id]} · ${confirmedConnections.has(id) && site.state === "ready" ? "已确认连接" : labels[site.state] || site.state}`;
    row.querySelector("p").textContent = site.message || "等待连接检查";
    const confirm = $("confirm-" + id);
    if (confirm) { confirm.disabled = loginFinishing || confirmationRequestedAt.has(id); confirm.textContent = confirmingSite === id || confirmationRequestedAt.has(id) ? "正在确认…" : confirmedConnections.has(id) ? "重新确认连接" : "确认连接"; }
    if (id === "tencent" && confirmedConnections.has(id)) $("readiness-destination-status").textContent = site.state === "ready" ? "文档连接已确认。" : "已确认过文档链接，正在重新核验连接状态。";
  }
  $("readiness-enter").disabled = !allConnectionsConfirmed();
  $("readiness-message").textContent = readinessError || (allConnectionsConfirmed()
    ? redfoxMode() ? "红狐配置已就绪，可以进入查询；腾讯文档交付前仍需确认连接。" : "三个连接均已确认，可以进入创作台。"
    : readiness?.checking ? "正在实际检查连接，请稍候…" : redfoxMode() ? "请先配置红狐 API；腾讯文档可在交付前确认。" : `当前有效连接 ${verifiedConnectionCount()}/3。登录后回到这里逐个确认连接。`);
  const tencent = readiness?.sites?.find((s) => s.id === "tencent");
  $("tencent-credential-form").hidden = !tencent?.reauthorization_required;
}
async function checkReadiness(sites) {
  if (readinessBusy) return;
  readinessBusy = true;
  readinessError = "";
  lastReadinessCheck = Date.now();
  renderReadiness();
  try { readiness = await api("/api/readiness/check", sites ? {sites} : {}); }
  catch (error) { readinessError = error.message; }
  finally { readinessBusy = false; renderReadiness(); }
}
let loginOpening = false;
async function connectCollector(site) {
  if (!["douyin", "douhot"].includes(site)) return;
  if (loginOpening) return;
  loginOpening = true;
  readinessError = "正在打开真实浏览器登录窗口…";
  renderReadiness();
  try {
    const current = await api("/api/collector/status");
    if (current.state === "login_open" && current.site !== site) throw Error("请先确认当前平台的连接，再登录下一个平台。现有登录页面已保留。");
    confirmedConnections.delete(site);
    await api("/api/collector/login", {site});
    await refreshStatus();
    readinessError = "请在浏览器完成登录，回到桌面创作台点击该平台旁的“确认连接”。";
  } catch (error) { readinessError = error.message; }
  finally { loginOpening = false; renderReadiness(); }
}
window.addEventListener("message", (event) => {
  if (event.origin === location.origin && event.data?.type === "crawl-login-complete") {
    readinessError = "";
    refreshStatus().catch((error) => show(error, true));
  }
});
$("readiness-dialog").addEventListener("cancel", (event) => event.preventDefault());
async function confirmConnection(site) {
  if (loginFinishing || confirmationRequestedAt.has(site)) return;
  loginFinishing = true; confirmingSite = site; readinessError = ""; renderReadiness();
  try {
    const current = await api("/api/collector/status");
    if (current.state === "login_open" && current.site !== site) throw Error("请先确认正在登录的平台，当前登录窗口会保持打开。");
    confirmedConnections.delete(site); confirmationRequestedAt.set(site, Date.now());
    if (current.state === "login_open") {
      const result = await api("/api/collector/resume", {site:current.site,session_id:current.login_session_id});
      readiness = result.readiness; readinessError = ""; await refreshStatus();
    }
    else { readiness = await api("/api/readiness/check", {sites:[site]}); }
  } catch (error) { confirmationRequestedAt.delete(site); readinessError = error.message; }
  finally { loginFinishing = false; confirmingSite = null; renderReadiness(); }
}
async function refreshConnectionState() {
  if (readinessBusy) return;
  readinessBusy = true; readinessError = ""; renderReadiness();
  try {
    const current = await api("/api/collector/status");
    if (current.state === "login_open") {
      readiness = await api("/api/readiness");
      readinessError = "当前登录窗口已保留。完成登录后，请点击对应平台的“确认连接”。";
    } else readiness = await api("/api/readiness/check", {});
    await refreshStatus();
  } catch (error) { readinessError = error.message; }
  finally { readinessBusy = false; renderReadiness(); }
}
$("readiness-check").onclick = refreshConnectionState;
$("refresh-state").onclick = refreshConnectionState;
$("readiness-enter").onclick = () => {
  if (!allConnectionsConfirmed()) return;
  readinessEntered = true;
  $("readiness-dialog").close();
};
$("readiness-local").onclick=()=>{
  readinessEntered="local";$("readiness-dialog").close();
  show("已进入本地素材模式。联网查询需配置红狐，文档交付需确认腾讯目标；学习仍按质量状态开放。");
};
$("tencent-credential-form").onsubmit = async (event) => {
  event.preventDefault();
  const input = $("tencent-credential");
  try {
    await api("/api/readiness/tencent-credential", { token: input.value });
    input.value = "";
    await checkReadiness();
  } catch (error) { input.value = ""; readinessError = error.message; renderReadiness(); }
};
function savePools() {
  try {
    localStorage.setItem("crawl-saved-pools-v2", JSON.stringify(pools));
  } catch {
    show("浏览器无法保存已选题；请勿关闭页面。", true);
  }
}
function updatePageVisibility() {
  const isGame = page === "discover",
    isHotspot = page === "hotspots";
  $("discover-view").hidden =
    page === "tasks" || (isHotspot && hotspotView === "saved");
  $("saved-view").hidden = !isHotspot || hotspotView !== "saved";
  $("tasks-view").hidden = page !== "tasks";
  $("game-context").hidden = !isGame;
  $("game-navigation").hidden = !isGame;
  $("hotspot-navigation").hidden = !isHotspot;
  $("game-sync-controls").hidden = !isGame || sourceMode !== "game";
  $("sync-game").hidden = !isGame || sourceMode !== "game";
  $("course-controls").hidden = !isGame || sourceMode !== "courses";
  $("rank-controls").hidden = !isHotspot;
  $("fetch-hotspots").hidden = !isHotspot;
  for (const [id, selected] of [
    ["hotspot-source", hotspotView === "board"],
    ["selected-source", hotspotView === "saved"],
  ]) {
    $(id).classList.toggle("selected", selected);
    $(id).setAttribute("aria-pressed", String(selected));
  }
}
function switchPage(next) {
  page = next === "saved" ? "hotspots" : next;
  if (!$("message").classList.contains("error")) show("");
  const titles = {
    discover: ["游戏广场", "看懂游戏，找到灵感。"],
    hotspots: ["热点广场", "好选题，从这里发生。"],
    tasks: ["创作任务", "输出新的创作方案"],
  };
  document
    .querySelectorAll("[data-page]")
    .forEach((n) => n.classList.toggle("active", n.dataset.page === page));
  $("page-slogan").textContent = titles[page][1];
  if (page !== "tasks")
    setSource(page === "discover" ? gameSourceMode : "hotspot");
  updatePageVisibility();
  renderComposer();
}
function setSource(mode) {
  sourceMode = mode;
  if (page === "discover" && mode !== "hotspot") gameSourceMode = mode;
  $("query").value = "";
  for (const kind of ["game", "courses"]) {
    $(`${kind}-source`).classList.toggle("selected", kind === mode);
    $(`${kind}-source`).setAttribute("aria-pressed", String(kind === mode));
  }
  records = [];
  renderRecords();
  updatePageVisibility();
  loadRecords().catch((e) => show(e, true));
}
function renderComposer() {
  const chosen = $("draft-source").value,
    rows = pool();
  $("draft-source").replaceChildren(
    new Option(rows.length ? "选择要创作的选题" : "请先从前两页确认选题", ""),
    ...rows.map(
      (row) =>
        new Option(
          (row.collection === "games" ? "游戏作品 · " : "热点选题 · ") +
            (row.title || row.source_id),
          rowKey(row),
        ),
    ),
  );
  if (rows.some((row) => rowKey(row) === chosen))
    $("draft-source").value = chosen;
  const candidate = qualityCapabilities?.creative_candidate?.enabled && qualityCapabilities?.creative_candidate?.configured;
  const fixedStudy = currentProfile?.game===game() && currentProfile?.learning_source==="network" && currentProfile?.task_id && currentProfile?.version;
  $("create-draft").disabled = !(candidate && fixedStudy || qualityCapabilities?.creation?.enabled) || !game() || !$("draft-source").value;
  $("composer-help").textContent = !game()
    ? "请先到游戏广场确定目标游戏。"
    : candidate
      ? fixedStudy ? `${game()} · 以固定游戏认知和所选原片生成创作草稿；不追加收费搜索，审阅后另行交付。` : `${game()} · 请先在游戏广场完成联网学习，保留认知版本后再创作。`
    : qualityCapabilities?.creative_candidate?.enabled && !qualityCapabilities?.creative_candidate?.configured
      ? "尚未配置可用的宿主助手执行器，请检查连接与安装配置。"
    : !qualityCapabilities?.creation?.enabled
      ? "可继续选择素材；创作与腾讯文档输出须在学习质量和方案验收通过后恢复。"
    : currentProfile?.status === "ready"
      ? `${game()} · 选择已确认选题，生成完整创作方案。`
      : `${game()} · 可先确认选题；生成方案前需完成至少20组独立内容的游戏学习。`;
}
function sendToTask(row) {
  if (!game()) throw Error("请先在游戏广场确定目标游戏。");
  if (!pool().some((r) => rowKey(r) === rowKey(row))) toggleSaved(row);
  if ($("detail-dialog").open) closeMaterial();
  switchPage("tasks");
  $("draft-source").value = rowKey(row);
  $("mode").value = row.collection === "games" ? "A" : "B";
  renderComposer();
}
function scope() {
  const board = sourceProviders.hotspots === "redfox" ? "redfox_daily_hot" : $("board").value ? Number($("board").value) : null;
  const category = $("category").value;
  if (category !== "all" && board >= 2000)
    throw Error("行业筛选仅适用于视频榜，请调整榜单或选择不限行业。");
  return {
    keyword: $("query").value.trim(),
    board,
    category,
    hours: Number($("hours").value),
  };
}
async function loadRecords() {
  const generation = ++listGeneration,
    target = game(),
    mode = sourceMode;
  $("material-heading").textContent =
    mode === "game"
      ? `${target || "目标游戏"} · 视频候选`
      : mode === "courses"
        ? "创作课堂 · 公开来源"
        : "热点榜单 · 实际采集";
  if (mode === "game" && !target) {
    records = [];
    renderRecords();
    return;
  }
  const params =
    mode === "game"
      ? new URLSearchParams({
          game: target,
          q: $("query").value.trim(),
          sort: "newest",
        })
      : mode === "courses"
        ? new URLSearchParams({
            collection: "courses",
            q: $("query").value.trim(),
            sort: "newest",
          })
        : new URLSearchParams({
            board: scope().board || "",
            hours: scope().hours,
            category: scope().category,
            q: scope().keyword,
            sort: $("sort").value,
          });
  if (!records.length)
    $("material-summary").textContent = "正在读取实际采集记录…";
  let result;
  try {
    if(mode === "game") {
      const [online,local] = await Promise.allSettled([
        api("/api/hotspots?" + params),
        api("/api/local-videos?game=" + encodeURIComponent(target)),
      ]);
      if(online.status === "rejected" && local.status === "rejected") throw online.reason;
      result = online.status === "fulfilled" ? online.value : {records:[],collection:null};
      const onlineRows = Array.isArray(result.records) ? result.records : [];
      const query = $("query").value.trim().toLocaleLowerCase();
      const allLocalRows = local.status === "fulfilled" && Array.isArray(local.value.records) ? local.value.records : [];
      const localRows = allLocalRows.filter(row=>!query || String(row.title||"").toLocaleLowerCase().includes(query));
      const linked = new Map();
      for(const row of allLocalRows) for(const id of row.matching_online_ids || []) linked.set(id,row);
      const shownOnline = onlineRows.map(row=>linked.has(row.source_id) ? {...row,local_upload:linked.get(row.source_id)} : row);
      const displayed = new Set(onlineRows.map(row=>row.source_id));
      result = {...result,records:[...shownOnline,...localRows.filter(row=>!(row.matching_online_ids||[]).some(id=>displayed.has(id)))]};
      result.local_read_notice = [online.status === "rejected" ? "联网结果读取失败，当前仅显示已上传视频" : "",local.status === "rejected" ? "本地视频读取失败，联网结果仍保留" : ""].filter(Boolean).join("；");
    } else result = await api("/api/hotspots?" + params);
  } catch (error) {
    if (generation === listGeneration) {
      $("material-summary").textContent =
        "读取失败；保留的本地显示可能已过时。请检查连接后重试。";
    }
    throw error;
  }
  if (generation !== listGeneration || target !== game() || mode !== sourceMode)
    return;
  records = Array.isArray(result.records) ? result.records : [];
  localUploadNotice = result.local_read_notice || "";
  recordCollection = result.collection || null;
  if (mode !== "hotspot")
    records = records.filter((row) => row.kind === "video");
  renderRecords();
  renderGameState();
}
function sourceURL(row) {
  return (
    row.url ||
    row.source_url ||
    (row.kind === "video" && /^\d+$/.test(String(row.source_id))
      ? `https://www.douyin.com/video/${row.source_id}`
      : "")
  );
}
function hotspotScopeLabel() {
  return ["board", "hours", "category"]
    .map((id) => $(id).selectedOptions[0]?.textContent || "")
    .join(" · ");
}
function requestMatchesProvider(r, kind) {
  return (r.payload?.provider || "browser") === sourceProviders[kind];
}
function blocksNewQuery(r) {
  if (r.state !== "pending") return false;
  if (r.payload?.provider !== "redfox") return true;
  if (bridge?.collector?.active_request_id === r.id) return true;
  const job = bridge?.collector?.recent?.find(job => job.request_id === r.id);
  return !job?.attempts || (job.state === "running" && job.lease > Date.now());
}
function pendingHotspotRequest() {
  const selected = scope();
  return (bridge?.pending || []).find(r =>
    r.kind === "search" && r.task_id == null && requestMatchesProvider(r,"hotspots") && blocksNewQuery(r) &&
    r.payload?.purpose === "hotspots" && (r.payload.board ?? null) === selected.board &&
    r.payload.hours === selected.hours && String(r.payload.category || "all") === selected.category && !r.payload.keyword);
}
function matchesCurrentSearch(r) {
  if (r.kind !== "search" || r.task_id != null) return false;
  if (!requestMatchesProvider(r, sourceMode === "hotspot" ? "hotspots" : "game")) return false;
  if (sourceMode === "hotspot") {
    const selected = scope();
    return r.payload?.purpose === "hotspots" && (r.payload.board ?? null) === selected.board &&
      r.payload.hours === selected.hours && String(r.payload.category || "all") === selected.category && !r.payload.keyword;
  }
  return sourceMode === "courses" ? r.payload?.purpose === "courses" :
    r.payload?.purpose === "game-research" && r.payload.keyword === game();
}
function renderRecords() {
  $("local-upload-area").hidden = sourceMode !== "game";
  const uploadCount = records.filter(row => row.provider === "local_upload" || row.local_upload).length;
  $("local-upload-summary").textContent = game()
    ? `上传到「${game()}」 · 当前列表含 ${uploadCount} 条本地原片。上传后在下方素材列表预览；学习时在上方选择「本地视频」。`
    : "先输入目标游戏，再上传对应视频。";
  $("upload-local-video").disabled = !game() || Boolean(localUploadController);
  if (sourceMode === "game")
    $("record-count").textContent = String(records.length);
  if (sourceMode === "hotspot")
    $("hotspot-count").textContent = String(records.length);
  const signature = JSON.stringify(records);
  if (signature !== cardSignature) {
    $("cards").replaceChildren(...records.map((row) => materialCard(row)));
    cardSignature = signature;
  }
  $("no-results").hidden = records.length > 0;
  const collectionInfo = recordCollection?.requested_scope &&
    matchesCurrentSearch({kind:"search",payload:recordCollection.requested_scope}) ? recordCollection : null;
  $("fetch-game-media").hidden = sourceMode !== "game" || sourceProviders.game !== "redfox";
  $("fetch-game-media").disabled = collectionInfo?.latest_request?.state !== "fulfilled" || !records.length;
  const requestVersions = [
    ...(collectionInfo?.latest_request ? [collectionInfo.latest_request] : []),
    ...(bridge?.pending || []).filter(matchesCurrentSearch),
    ...(bridge?.recent || []).filter(matchesCurrentSearch),
  ];
  const byRequest = new Map();
  for (const candidate of requestVersions) {
    const previous = byRequest.get(candidate.id);
    const updated = Date.parse(candidate.updated_at) || 0;
    const priorUpdated = Date.parse(previous?.updated_at) || 0;
    if (!previous || updated > priorUpdated ||
      (updated === priorUpdated && previous.state === "pending" && candidate.state !== "pending"))
      byRequest.set(candidate.id,candidate);
  }
  // Merge versions first; then stable creation ordering retains the API's
  // authoritative latest ID when two different requests share a millisecond.
  const requests = [...byRequest.values()].sort((a,b) =>
    (Date.parse(b.created_at) || 0) - (Date.parse(a.created_at) || 0));
  const recentRequest = requests[0];
  const pendingRequest = recentRequest && blocksNewQuery(recentRequest) ? recentRequest : null;
  const pending = Boolean(pendingRequest);
  const failedRequest = !pending && ["failed", "expired", "cancelled"].includes(recentRequest?.state) ? recentRequest : null;
  const active = pending && bridge?.collector?.active_request_id === pendingRequest.id;
  const waitingText = automaticSearch() ? (active ? "后台正在采集" : "已排队，等待后台采集") : "等待助手同步";
  const displayedSources = records.flatMap(row => row.grouped_sources?.length ? row.grouped_sources : [row]);
  const captured = displayedSources
    .map((r) => Date.parse(r.collected_at))
    .filter(Number.isFinite);
  const latest = captured.length ? Math.max(...captured) : null;
  const sourceCount = records.reduce(
    (count, row) => count + (row.source_count || 1),
    0,
  );
  const contentCount =
    sourceCount > records.length
      ? `${records.length} 组内容 · ${sourceCount} 个来源（同内容已合并）`
      : `${records.length} 条实际采集候选`;
  const localCount = records.filter(row=>row.provider === "local_upload" || row.local_upload).length;
  const cacheInfo = localCount && records.every(row=>row.provider==="local_upload")
    ? " · 本地上传时间见详情；作品发布时间未知"
    : latest
    ? ` · 最近采集 ${date(latest)}（约 ${Math.max(0, Math.floor((Date.now() - latest) / 60000))} 分钟前）`
    : " · 采集时间未记录";
  $("material-summary").textContent =
    sourceMode === "game"
      ? localCount ? `${records.length} 条素材 · ${records.filter(row=>row.provider !== "local_upload").length} 条联网记录 · ${localCount} 条含本地上传（相同原片合并显示）` : contentCount
      : sourceMode === "courses"
        ? `${records.length} 条公开课程 · 来源封面与课程链接已收录`
        : `${hotspotScopeLabel()} · ${records.length} 条已采集${pending ? " · " + waitingText : ""}`;
  $("material-summary").textContent += cacheInfo;
  if(sourceMode === "game" && localUploadNotice) $("material-summary").textContent += " · " + localUploadNotice;
  // A failed refresh must remain visible even when historical rows exist.
  // Retaining cached material does not mean the current request succeeded.
  if (failedRequest)
    $("material-summary").textContent += ` · 本次未更新${records.length ? "，正在展示历史采集内容" : ""}：${failedRequest.error || "来源采集失败"}`;
  else if (pending)
    $("material-summary").textContent += `${sourceMode !== "hotspot" ? " · " + waitingText : ""}${records.length ? "，当前为历史采集内容" : ""}`;
  const batches = new Set(displayedSources.map(r => r.snapshot_id).filter(id => id != null));
  if (batches.size > 1 && captured.length)
    $("material-summary").textContent += ` · 包含 ${batches.size} 个采集批次，最早采集 ${date(Math.min(...captured))}`;
  if (recentRequest?.state === "fulfilled" && collectionInfo?.latest_request?.id === recentRequest.id) {
    const selection = collectionInfo.selection_summary;
    if (collectionInfo.provider === "redfox" && selection) {
      const labels = {non_video:"非视频",type_unknown:"类型未知",duplicate:"重复作品",sample_limit:"超出样本上限",outside_date_range:"日期不符",category_mismatch:"行业不符",local_keyword_mismatch:"关键词不符",keyword_mismatch:"游戏关键词不符",other:"其他未纳入项"};
      const excluded = Object.entries(labels).filter(([key]) => selection.excluded_counts?.[key] > 0)
        .map(([key,label]) => `${label} ${selection.excluded_counts[key]} 条`).join("、");
      $("material-summary").textContent += ` · 接口返回 ${selection.response_count} 条，保留 ${selection.retained_count} 条视频${excluded ? `；未纳入：${excluded}` : ""}（仅本次响应）`;
    }
    if (collectionInfo.status === "partial" && collectionInfo.failures?.length)
      $("material-summary").textContent += ` · 本次仅部分采集成功：${collectionInfo.failures.join("；")}`;
    const historical = collectionInfo.historical_source_count + collectionInfo.unattributed_source_count;
    if (historical)
      $("material-summary").textContent += ` · 当前列表有 ${historical} 个来源不属于本次采集`;
    if (collectionInfo.completeness === "unverified")
      $("material-summary").textContent += " · 完整采集范围尚未核验";
    if (["accessible_pages_complete", "partial_accessible_pages"].includes(collectionInfo.completeness)) {
      const boards = collectionInfo.pagination?.boards || [];
      const pages = boards.reduce((sum, board) => sum + board.pages.length, 0);
      $("material-summary").textContent += ` · 已读取${collectionInfo.completeness === "partial_accessible_pages" ? "成功榜单的" : "全部"}可访问分页（${pages} 页）`;
      const difference = boards.reduce((sum, board) => sum + board.metadata_total_difference, 0);
      if (difference > 0)
        $("material-summary").textContent += ` · 来源标称总数比实际返回多 ${difference} 条，未补造缺失内容`;
    }
  }
  $("sync-game").disabled = searchBusy || !game() || pending;
  $("sync-game").textContent = pending
    ? waitingText
    : searchBusy
      ? "核验学习来源…"
      : sourceProviders.game === "redfox" ? "开始查询" : "同步抖音";
  $("sync-status").textContent = pending
    ? automaticSearch() ? waitingText + "，完成后自动显示结果。" : "同步请求已保存，等待当前聊天中的助手操作右侧抖音。"
    : $("auto-sync").checked
      ? `页面保持开启且可见时，每 10 分钟提交一次同步请求；下次约 ${date(nextSyncAt)}。${automaticSearch() ? "已提交任务由后台执行。" : "助手空闲时只排队，不会自动采集。"}`
      : automaticSearch() ? "切换游戏后自动采集；现有记录保留采集时间。" : "按需同步；页面不会自行操作右侧浏览器。";
  $("fetch-hotspots").disabled = hotspotSearchBusy || (sourceMode === "hotspot" && Boolean(pending));
  $("fetch-hotspots").textContent =
    sourceMode === "hotspot" && pending ? waitingText : sourceProviders.hotspots === "redfox" ? "开始查询" : "获取榜单热点";
  if (redfoxMode()) {
    $("sync-status").textContent = pending ? waitingText + "，完成后自动显示。" : "仅点击开始查询才调用 API；每次最多3页，按当前单价最多1.2积分。切换条件和刷新状态不收费。";
    if (recentRequest?.state === "pending" && !pending) $("material-summary").textContent += " · 上次查询已中断；点击开始查询可手动重试，可能再次计费";
    const actual = collectionInfo?.observed_scope;
    if (actual?.site === "redfox") $("material-summary").textContent += ` · 红狐 T+1 · ${actual.start_date} 至 ${actual.end_date}（北京时间自然日）`;
    if (collectionInfo?.api_pagination?.status === "partial") $("material-summary").textContent += " · 有限分页样本，并非全库热门排名";
  }
  $("empty-heading").textContent = pending ? waitingText : failedRequest ? "本次采集未完成" : "还没有符合条件的素材";
  $("empty-help").textContent = pending
    ? automaticSearch() ? "后台正在处理所选条件；完成后自动更新，无需在聊天中回填。" : sourceMode === "hotspot"
      ? `${hotspotScopeLabel()}：请求已保存，等待助手按这些条件读取热点宝。`
      : "搜索请求已保存，等待当前聊天中的助手读取右侧抖音页面。"
    : failedRequest ? `${failedRequest.error || "来源采集失败"}。请检查连接后重新获取；这不表示来源没有内容。` : sourceMode === "game"
      ? `尚无${game() ? "「" + game() + "」的" : ""}匹配视频。请点击上方查询按钮；没有本地记录不代表没有相关作品。`
      : sourceMode === "courses"
        ? "尚未收录公开课程。点击「查找 / 更新公开课程」，等待助手从实际页面采集。"
        : "当前榜单范围没有本地记录，请主动获取榜单热点。";
}
function materialText(value, fallback) {
  return typeof value === "string" && value.trim() ? value : fallback;
}
function materialMetricLabel(row, key) {
  const label = key === "play_count" ? "播放" : "点赞";
  if (row.source_endpoint === "douhot-page-response") return label;
  return row.source_endpoint === "douhot-visible-page" ? `新增${label}` : label;
}
function materialCard(row, saved = false) {
  const article = el("article", "", "material");
  article.dataset.materialKey = rowKey(row);
  const preview = materialPreview(row);
  if (preview) {
    const cover = button("", () => openMaterial(row), "cover-button");
    cover.setAttribute("aria-label", `查看素材：${materialText(row.title, "未提供标题")}`);
    cover.append(preview);
    article.append(cover);
  }
  const body = el("div", "", "material-body");
  body.append(
    el(
      "div",
      row.kind === "video"
        ? row.provider === "local_upload" ? "本地上传 · 学习素材" : row.local_upload ? "联网来源 · 同时有本地原片" : "抖音视频 · 来源记录"
        : `${row.kind || "热点"} · 榜单记录`,
      "meta",
    ),
  );
  const title = el("h3");
  title.append(button(materialText(row.title, "未提供标题"), () => openMaterial(row), ""));
  body.append(title);
  if (row.source_count > 1)
    body.append(
      el(
        "p",
        `同内容 · ${row.source_count} 个来源 · 学习仅计 1 组`,
        "content-group-note",
      ),
    );
  const metrics = [];
  for (const [key, label] of [
    ["score", "来源热度"],
    [
      "play_count",
      materialMetricLabel(row, "play_count"),
    ],
    [
      "like_count",
      materialMetricLabel(row, "like_count"),
    ],
    ["comment_count", "评论"],
    ["share_count", "分享"],
  ])
    if (key === "like_count" && row.like_display)
      metrics.push(`${label} ${row.like_display}`);
    else if (row[key] !== undefined && row[key] !== null)
      metrics.push(`${label} ${row[key]}`);
  body.append(
    el(
      "p",
      metrics.length
        ? metrics.join(" · ")
        : "来源未提供可用热度指标；不作热门或优质认定。",
    ),
  );
  const bottom = el("div", "", "card-bottom");
  bottom.append(
    el("span", materialText(row.author, "作者未记录")),
    button(
      saved ? "移出已选题" : "查看证据 ↗",
      () => (saved ? toggleSaved(row) : openMaterial(row)),
      saved ? "remove" : "",
    ),
  );
  if (saved) bottom.append(button("创作方案 →", () => sendToTask(row), ""));
  body.append(bottom);
  article.append(body);
  return article;
}
function materialPreview(row) {
  let sourceCover = false;
  try {const u = new URL(row.thumbnail_url); sourceCover = row.provider === "redfox" && row.thumbnail_provenance?.kind === "source_cover" && u.protocol === "https:" && !u.port && !u.username && !u.password && u.hostname.endsWith(".douyinpic.com");} catch {}
  if (!sourceCover && !/^\/api\/media\/\d{10,25}\/thumbnail$/.test(row.thumbnail_url || "")) return null;
  const image = el("img", "", "source-preview");
  image.referrerPolicy = "no-referrer";
  image.src = row.thumbnail_url;
  image.alt =
    row.thumbnail_provenance?.kind === "source_cover"
      ? "抖音原作品封面"
      : row.thumbnail_provenance?.kind === "video_frame"
        ? "原片画面预览"
        : "原作品预览图";
  image.loading = "lazy";
  image.addEventListener(
    "error",
    () => image.closest(".cover-button")?.remove() || image.remove(),
    { once: true },
  );
  return image;
}
function renderPool() {
  $("saved-count").textContent = String(pool().length);
  $("saved-cards").replaceChildren(
    ...pool().map((row) => materialCard(row, true)),
  );
  $("saved-empty").hidden = pool().length > 0;
  renderComposer();
}
function toggleSaved(row) {
  if (!game()) throw Error("请先输入目标游戏。");
  const rows = pool(),
    exists = rows.some((r) => rowKey(r) === rowKey(row));
  pools[game()] = exists
    ? rows.filter((r) => rowKey(r) !== rowKey(row))
    : [...rows, row];
  savePools();
  renderPool();
  if (activeRow)
    $("save-topic").textContent = pool().some(
      (r) => rowKey(r) === rowKey(activeRow),
    )
      ? "已加入 · 移出已选题"
      : "＋ 加入已选题";
}
let mediaQuote = null, mediaSelection = null, mediaGeneration = 0, mediaPoll = null;
async function openMediaAcquisition(requestId, ids, renew = false) {
  const generation = ++mediaGeneration;
  clearTimeout(mediaPoll);
  mediaQuote = null;
  mediaSelection = {request_id:requestId,source_ids:ids ? [...ids] : undefined,renew};
  const dialog = $("media-acquisition-dialog");
  $("media-acquisition-status").replaceChildren(el("p","正在核对本地原片与费用，不调用收费接口…"));
  $("media-acquisition-actions").replaceChildren();
  if (!dialog.open) dialog.showModal();
  try {
    const quote = await api("/api/media-acquisition/quote",mediaSelection);
    if(generation !== mediaGeneration || !dialog.open) return;
    mediaQuote = quote;
    renderMediaAcquisition();
  } catch(error) {
    if(generation === mediaGeneration) $("media-acquisition-status").replaceChildren(el("p",error.message,"notice"));
  }
}
function renderMediaAcquisition() {
  const q = mediaQuote;
  if(!q || !$("media-acquisition-dialog").open) return;
  const status = $("media-acquisition-status"),actions = $("media-acquisition-actions");
  status.replaceChildren();actions.replaceChildren();
  status.append(el("p",`${q.scope.game || (q.scope.category ? q.scope.category+" · 热门视频" : "热门视频")} · ${q.scope.start_date} 至 ${q.scope.end_date} · 原查询 ${date(q.scope.collected_at)}`));
  status.append(el("p",`选中 ${q.items.length} 条 · 已有原片 ${q.counts.reused + (q.counts.cached || 0)} · 本次取得 ${q.counts.ready} · 等待 ${q.counts.queued + (q.counts.cached || 0)} · 处理中 ${q.counts.running}`));
  status.append(el("p",`最多解析 ${q.max_requests} 次，费用上限约 ${q.max_points} 积分；已尝试 ${q.attempted_requests} 次。${q.price_note}`));
  status.append(el("p","只获取真实原片及抽帧音轨，不启动模型分析或腾讯文档写入。"));
  const labels={quoted:"待确认费用",queued:"等待获取",running:"正在获取",partial:"部分未完成",completed:"原片获取完成",cancelled:"已停止"};
  status.append(el("p",labels[q.state] || q.state,"notice"));
  for(const item of q.items.filter(item=>item.error)) status.append(el("p",`${item.title || item.source_id}：${item.error}`));
  if(q.state === "quoted") actions.append(button(`确认获取（最多 ${q.max_points} 积分）`,async()=>{
    const generation = mediaGeneration;
    const next = await api("/api/media-acquisition/start",{quote_id:q.id,user_initiated:true,max_requests:q.max_requests});
    if(generation !== mediaGeneration) return;
    mediaQuote = next;renderMediaAcquisition();
  },"primary"));
  if(["queued","running"].includes(q.state)) {
    actions.append(button("停止获取",async()=>{
      const generation = mediaGeneration;
      const next = await api(`/api/media-acquisition/${q.id}/cancel`,{});
      if(generation !== mediaGeneration) return;
      mediaQuote = next;renderMediaAcquisition();
    }));
    clearTimeout(mediaPoll);
    const generation = mediaGeneration;
    mediaPoll = setTimeout(async()=>{
      try {
        const next = await api(`/api/media-acquisition/${q.id}`);
        if(generation !== mediaGeneration || !$("media-acquisition-dialog").open) return;
        mediaQuote = next;renderMediaAcquisition();
      } catch(error) {if(generation === mediaGeneration) status.append(el("p","状态读取失败；未重试付费请求，请重新查看原片状态。","notice"));}
    },2000);
  }
  if(["partial","cancelled"].includes(q.state) && mediaSelection) {
    const retryIds=q.items.filter(item=>["failed","interrupted","cancelled"].includes(item.state)).map(item=>item.source_id);
    if(retryIds.length) {
      actions.append(button("重试前查看费用",()=>openMediaAcquisition(q.request_id,retryIds)));
      actions.append(button("重新解析链接 / 查看费用",()=>openMediaAcquisition(q.request_id,retryIds,true)));
      status.append(el("p","重试优先复用已保存的解析链接；链接过期可选择重新解析，需再次确认费用。"));
    }
  }
}
function openMaterial(row) {
  if (materialClosing) return;
  activeRow = row;
  const isCourse = row.collection === "courses";
  $("send-to-task").hidden = isCourse;
  $("save-topic").hidden = isCourse;
  $("detail-image").replaceChildren();
  const local = row.provider === "local_upload" ? row : row.local_upload;
  if(local && /^local_[a-f0-9]{64}$/.test(local.source_id)) {
    const video=el("video","","source-preview");
    video.controls=true;video.preload="metadata";
    video.src=`/api/local-videos/${local.source_id}/media`;
    $("detail-image").append(video);
  }
  const preview = materialPreview(row);
  if (preview && !local) $("detail-image").append(preview);
  $("detail-badge").textContent =
    row.kind === "video"
      ? "实际视频来源 · 待核验"
      : "实际热点来源 · 待关联原片";
  $("detail-title").textContent = materialText(row.title, "未提供标题");
  $("detail-desc").textContent =
    local ? "视频已保存在本机；上传不调用红狐、不自动开始学习。文件不含可核对的抖音互动和发布时间时保持未知，上传成功不代表内容质量已通过。" : "以下为来源页面信息，不代表已验证玩法或内容质量。原片阅读与字幕核对状态以任务证据为准；未提供核对记录时，自动语音仍为未核对。";
  const evidence = $("evidence-panel");
  evidence.replaceChildren();
  if(local) evidence.append(el("p",`本地原片 · 上传 ${date(local.uploaded_at)} · ${local.has_audio ? "含音频" : "未检测到音频"} · 不以上传时间代替作品发布时间。`,"notice"));
  if(row.provider === "redfox" && row.kind === "video" && row.collection_request_id)
    evidence.append(button("获取原片 / 查看费用", () => openMediaAcquisition(row.collection_request_id,[row.source_id])));
  for (const [label, value] of [
    ["作者", materialText(row.author, "作者未记录")],
    ["采集时间", date(row.collected_at)],
    ["搜索排序", row.sort_basis || "来源未记录"],
    ["实际范围", row.scope || "来源未记录"],
    ["来源编号", row.source_id],
    [
      "来源范围",
      row.search_game ||
        row.game ||
        (row.sub_type
          ? `榜单 ${row.sub_type} · ${row.date_window || "?"} 小时`
          : "搜索候选"),
    ],
  ]) {
    const line = el("div", "", "evidence-row");
    line.append(el("span", label), el("b", value));
    evidence.append(line);
  }
  evidence.append(
    el("p", "原片阅读、时间戳与术语核对结果将在真实任务详情中展示。", "notice"),
  );
  if (row.source_count > 1 && row.grouped_sources?.length) {
    evidence.append(el("h3", `同内容的 ${row.source_count} 个来源`));
    evidence.append(
      el(
        "p",
        "已按用户确认合并展示，保留各来源；学习仅计一个独立内容组。归组不代表已完成画面和语音核验。",
        "notice",
      ),
    );
    for (const source of row.grouped_sources) {
      const sourceLine = el("div", "", "grouped-source");
      const sourcePreview = materialPreview(source);
      if (sourcePreview) sourceLine.append(sourcePreview);
      sourceLine.append(
        el("b", materialText(source.author, "作者未记录")),
        el("p", materialText(source.title, "未提供标题")),
      );
      if (source.like_display || source.like_count != null)
        sourceLine.append(
          el("p", `该来源点赞 ${source.like_display || source.like_count}`),
        );
      if (sourceURL(source))
        sourceLine.append(link("打开此来源 ↗", sourceURL(source)));
      evidence.append(sourceLine);
    }
  } else if (sourceURL(row))
    evidence.append(link("打开实际来源 ↗", sourceURL(row)));
  $("save-topic").textContent = pool().some((r) => rowKey(r) === rowKey(row))
    ? "已加入 · 移出已选题"
    : "＋ 加入已选题";

  if (!$("detail-dialog").open) {
    history.pushState({ crawlMaterial: true }, "");
    materialHistory = true;
  }
  $("detail-dialog").showModal();
  $("detail-dialog").scrollTop = 0;
}
function gameTasks() {
  return tasks.filter((t) => t.payload?.game === game());
}
const activeStates = ["queued", "running"];
const studyEntryEnabled=()=>learningSource()==="network"&&qualityCapabilities?.study?.enabled===true&&qualityCapabilities.study.configured===true;
const taskRoute=(task,action="")=>`${task.task_store==="game-study"?"/api/game-study-tasks":task.task_store==="creative-candidate"?"/api/creative-candidates":"/api/tasks"}/${task.id}${action?"/"+action:""}`;
function savedStudyTask(){
  if(!studyEntryEnabled()||!currentProfile?.task_id||recordCollection?.requested_scope?.purpose!=="game-research"||recordCollection.requested_scope.keyword!==game())return null;
  return tasks.find(t=>t.id===currentProfile.task_id&&t.task_store==="game-study"&&t.state==="completed"&&t.result?.comparisonMetrics?.collection_request_id===recordCollection.latest_request?.id)||null;
}
function renderGameState() {
  const active = gameTasks().find(
    (t) => t.type === "learn" && activeStates.includes(t.state)&&!t.resume_required&&(t.task_store!=="game-study"||t.payload.learning_source===learningSource()),
  );
  const resumable=gameTasks().some(t=>t.task_store==="game-study"&&t.resume_required),saved=savedStudyTask();
  $("learn-game").disabled = learningBusy || Boolean(active) || !game();
  $("learning-source").value = learningSource();
  $("learning-source").disabled = !game();
  $("learn-game").textContent = learningBusy
    ? "正在提交…"
    : active
      ? "学习任务进行中"
      : saved?"查看学习档案":studyEntryEnabled()?resumable?"继续学习":"学习游戏":"核对学习素材";
  $("find-game").disabled = searchBusy || !game();
  $("upload-local-video").disabled = Boolean(localUploadController) || !game();
  $("game-status").textContent = !game()
    ? "未指定"
    : active
      ? active.state_label || "处理中"
      : currentProfile
        ? currentProfile.learning_pipeline ? "认知候选已保存" : currentProfile.status === "ready" ? "初学完成" : "初学待补充"
        : "尚未学习";
  $("game-help").textContent = currentProfile
    ? currentProfile.learning_pipeline
      ? `${game()} · 已整理 ${currentProfile.coverage?.representative_count??0} 条代表视频 · 保存 ${date(currentProfile.created_at)}。这是待复核的认知候选，缺项保留；创作与文档输出另行验收。`
      : `${game()} · 资料版本 ${currentProfile.version || "未记录"} · ${currentProfile.independent_content_count ?? currentProfile.relevant_video_ids?.length ?? 0} 组独立内容 · 更新 ${date(currentProfile.created_at)}。${currentProfile.readiness_note || ""}${currentProfile.expires_at && Date.parse(currentProfile.expires_at) < Date.now() ? "资料已到期，请更新学习。" : ""}`
    : active
      ? `${game()} · ${active.stage || "等待执行"}。任务详情展示实际读取情况。`
      : "可联网查询，或上传本地视频保存为学习素材；上传不调用红狐，学习与创作仍分别核验质量。";
  if(studyEntryEnabled())$("game-help").textContent+=' 学习使用现有宿主助手账号和网络，不是离线推理；不自动调用红狐查询或解析。';
  else if(qualityCapabilities?.study?.enabled&&!qualityCapabilities.study.configured)$("game-help").textContent+=' 学习执行器尚未配置，当前可核对素材。';
  else if(qualityCapabilities?.learning?.enabled)$("game-help").textContent+=' 初学整理主题、范围与借鉴笔记；重点拆解与交付另行验收。';
  else $("game-help").textContent+=' 先选择学习来源；当前仅可核对已保存素材，正式学习尚未恢复。两类素材都会保留。';
  $("douyin-login").href = game()
    ? `https://www.douyin.com/search/${encodeURIComponent(game())}?type=video`
    : "https://www.douyin.com/";
}
async function loadProfile() {
  const target = game(),source=learningSource(target),
    generation = gameGeneration;
  let result=null;
  if(target){
    if(source==="network"){
      result=await api("/api/game-study-profile?"+new URLSearchParams({game:target,learning_source:source}));
    }
  }
  if (target !== game() || source!==learningSource(target) || generation !== gameGeneration) return;
  currentProfile = result;
  renderGameState();
  renderComposer();
}
async function learning() {
  if (!game() || learningBusy) return;
  const target=game(),source=learningSource(target),generation=gameGeneration;
  // Capture the explicit choice before the first await; later UI edits cannot
  // change the source/game of this check. No legacy task endpoint is invoked.
  const request={game:target,learning_source:source};
  learningBusy = true;
  renderGameState();
  try {
    const saved=savedStudyTask();
    if(saved){openTask(saved.id);return;}
    if(source==="network"&&studyEntryEnabled()){
      const task=await api("/api/game-study-tasks",request);
      await refreshStatus();
      if(target===game()&&source===learningSource(target)&&generation===gameGeneration){show(task.state==="completed"?"已读取保存的认知候选，没有重新学习。":"学习任务已接收；可在详情查看进度或停止。未新增红狐查询或解析。");openTask(task.id);}
      return;
    }
    const result=await api("/api/game-study-input",request);
    if(target!==game()||source!==learningSource(target)||generation!==gameGeneration)return;
    const label=source==="local"?"本地视频":"联网视频";
    show(`「${target}」${label}来源已核验：${result.coverage.selected_candidates} 条候选，${result.coverage.available_originals} 条可读原片，${result.coverage.unavailable_originals} 条缺原片。未开始学习、查询或解析；正式学习仍待验收。`);
  } finally {
    learningBusy = false;
    renderGameState();
  }
}
async function searchGame() {
  if (!game() || searchBusy) return;
  if (automaticSearch() && !(sourceProviders.game === "redfox" ? readiness?.game_collection_ready : readiness?.ready)) { renderReadiness(); return; }
  const target = game(), generation = gameGeneration;
  const waiting = (bridge?.pending || []).some(
    (r) =>
      r.kind === "search" && r.task_id == null && requestMatchesProvider(r,"game") && blocksNewQuery(r) &&
      r.payload?.purpose === "game-research" &&
      r.payload?.keyword === game(),
  );
  if (waiting) {
    show(automaticSearch() ? "后台已有该游戏的采集任务，结果会自动显示。" : "已有该游戏的同步请求，等待助手执行。无需重复提交。");
    return;
  }
  searchBusy = true;
  renderRecords();
  renderGameState();
  try {
    const result = await api("/api/game-search", { game: target, user_initiated:true });
    if (target !== game() || generation !== gameGeneration) return;
    setSource("game");
    switchPage("discover");
    show(
      result.reused_recent_result ? "已有同条件近期结果，保留原采集时间，本次未重复调用。" : result.queued
        ? automaticSearch() ? "后台已接收游戏搜索，完成后自动显示。" : "游戏搜索请求已保存，等待助手读取右侧抖音页面。"
        : "搜索请求已完成，正在读取实际结果。",
    );
    await refreshStatus();
  } finally {
    searchBusy = false;
    nextSyncAt = Date.now() + 10 * 60 * 1000;
    renderGameState();
    renderRecords();
    if (sourceProviders.game !== "redfox" && automaticSearch() && target !== game() && game() && page === "discover")
      queueMicrotask(() => searchGame().catch((e) => show(e, true)));
  }
}
function addJSON(parent, label, value, open = false) {
  if (value === undefined || value === null) return;
  const details = el("details");
  details.open = open;
  details.append(
    el("summary", label),
    el(
      "pre",
      typeof value === "string" ? value : JSON.stringify(value, null, 2),
    ),
  );
  parent.append(details);
}
function renderTasks() {
  const rows = gameTasks();
  $("task-count").textContent = String(rows.length);
  $("tasks-empty").hidden = rows.length > 0;
  $("task-list").replaceChildren(
    ...rows.map((t) => {
      const card = el("article", "", "task-card");
      card.append(
        el(
          "h3",
          t.type === "learn"
            ? `${t.payload.game} · 游戏学习`
            : t.task_store === "creative-candidate"
              ? `${t.payload.mode==="A"?"游戏作品改编":"热点联动"} · ${t.payload.source.source_id}`
            : t.payload.source?.title || "策划任务",
        ),
        el("p", `${t.state_label || t.state} · ${t.stage || "等待执行"}`),
        el("span", t.payload.game, "badge"),
      );
      if (t.error) card.append(el("p", t.error, "warning"));
      const actions = el("div", "", "button-row");
      actions.append(button("查看详情", () => openTask(t.id)));
      if (activeStates.includes(t.state))
        actions.append(
          button("取消任务", async () => {
            await api(taskRoute(t,"cancel"), {});
            await refreshStatus();
          }),
        );
      if (["failed", "needs_input", "cancelled"].includes(t.state) && t.retry_allowed)
        actions.append(
          button("补充条件后重试", async () => {
            await api(taskRoute(t,"retry"), {});
            await refreshStatus();
          }),
        );
      else if(["failed", "needs_input", "cancelled"].includes(t.state)&&t.retry_reason)actions.append(el("span",t.retry_reason,"muted"));
      card.append(actions);
      return card;
    }),
  );
  if ($("task-dialog").open && activeTaskId) {
    const t = tasks.find((item) => item.id === activeTaskId);
    if (t) renderTaskDetail(t);
  }
}
function openTask(id) {
  activeTaskId = id;
  taskDetailSignature = "";
  const t = tasks.find((item) => item.id === id);
  if (!t) throw Error("任务不存在，请刷新。");
  renderTaskDetail(t);
  if (!$("task-dialog").open) $("task-dialog").showModal();
}
function renderStudyDossier(root,result){
  const draft=result.draft,modes={fact:"来源陈述",observation:"内容观察",inference:"分析推测",design:"创作建议"};
  const claim=(parent,value)=>{
    if(!value)return;parent.append(el("p",`${modes[value.mode]||"说明"}：${value.text}`));
    if(value.references?.length){const refs=el("details");refs.append(el("summary","查看依据"));for(const ref of value.references)refs.append(el("p",`${ref.id}${ref.quote?" · "+ref.quote:" · 实际画面"}`,"small muted"));parent.append(refs);}
  };
  const count=result.source_counts||{};
  root.append(el("h3","游戏认知候选"),el("p",`${count.selected??0} 条候选 · ${count.available_originals??0} 条可读原片 · ${result.coverage?.representative_count??0} 条代表视频。缺原片 ${count.unavailable_originals??0} 条；未自动补充。`,"notice"));
  for(const [title,values]of [["游戏背景与基本活动",draft.background_and_loop],["玩家常见处境",draft.player_situations]]){root.append(el("h3",title));for(const value of values||[])claim(root,value);}
  root.append(el("h3","必要术语"));for(const term of draft.necessary_terms||[]){root.append(el("h4",term.term));claim(root,term.explanation);if(term.uncertainty)root.append(el("p","待核对："+term.uncertainty,"muted"));}
  root.append(el("h3","样本内容与表达"));for(const type of draft.content_types||[]){root.append(el("h4",`${type.name} · ${type.format==="video"?"视频":"图文"}`));claim(root,type.description);}for(const value of draft.expression_methods||[])claim(root,value);
  root.append(el("h3","平台依据与制作检查"));for(const value of draft.platform_actions||[]){claim(root,value.requirement);claim(root,value.production_action);root.append(el("p","检查："+value.checkpoint),el("p","适用范围："+value.applicability,"muted"));}
  root.append(el("h3","同类内容的表达借鉴"));for(const value of draft.peer_transfer||[]){root.append(el("h4",value.game));claim(root,value.observed_expression);claim(root,value.adaptation);root.append(el("p",`适用：${value.applicability}；不能移植：${value.not_transferable}`,"muted"));}
  const metrics=result.comparisonMetrics||{},window=metrics.window;
  root.append(el("h3","时长与互动样本"),el("p",window?`作品日期范围 ${window.start} 至 ${window.end}；数值仅描述已取得样本，缺失不补零，不推算曝光或最佳时长。`:"没有可比较的网络作品窗口。","muted"));
  const stats=value=>!value||!value.known?"未知":`${value.min}–${value.max}（已知${value.known}，缺失${value.missing}）`;
  for(const group of metrics.groups||[]){const detail=el("details");detail.append(el("summary",`${group.type} · ${group.sample_count}条 · ${group.classification_status==="reviewed"?"已有分类记录":"类型待核对"}`),el("p",`时长（秒）：${stats(group.duration_seconds)}`));for(const [key,label]of [["like_count","点赞"],["comment_count","评论"],["share_count","分享"],["collect_count","收藏"]])detail.append(el("p",`${label}：${stats(group.metrics?.[key])}`));root.append(detail);}
  root.append(el("h3","缺项与使用边界"));for(const value of draft.unknowns||[])root.append(el("p",value.text));
}
function renderCreativeCandidate(root,result,task){
  const coverage=result.coverage||{},plan=result.plan;
  root.append(el("h3","原片读取与拆解"),el("p",`已读 ${coverage.frames?.length||0} 张代表画面与${coverage.has_audio?"完整音轨自动转写":"无音轨素材"}；未连续观看动作，未核听音乐音效。`,"muted"));
  for(const reading of result.source_reading||[]){root.append(el("p",reading.text),el("p",`结构作用：${reading.role_in_structure}`,"muted"));const detail=el("details");detail.append(el("summary","依据与读取限制"),el("p",reading.limitation));for(const loc of reading.locations||[])detail.append(el("p",`${loc.id} · ${JSON.stringify(loc.coverage)}`,"small muted"));root.append(detail);}
  root.append(el("h3","游戏对照与结合"));
  for(const bridge of result.game_bridge||[]){root.append(el("p",bridge.proposed_action),el("p",`成立条件：${(bridge.conditions||[]).join("；")}`,"muted"),el("p",`不适用：${bridge.non_applicable}`,"muted"));const detail=el("details");detail.append(el("summary","游戏依据"));for(const ref of bridge.game_references||[])detail.append(el("p",`${ref.id} · ${ref.quote||"实际附图"}`,"small muted"));root.append(detail);}
  if(plan){root.append(el("h3","创作方案"),el("p",plan.meaning),el("p",plan.rationale));for(const idea of plan.ideas||[]){root.append(el("h4",idea.title),el("p",idea.bridge),el("p",`开头：${idea.hook}`),el("pre",idea.script));for(const shot of idea.shots||[])root.append(el("p",`${shot.position} · ${shot.visual}\n字幕：${shot.text}\n声音设计：${shot.sound}`));addJSON(root,"素材、制作档位与限制",{materials:idea.materials,tiers:idea.tiers,limitations:idea.limitations});}for(const gap of plan.blocking_gaps||[])root.append(el("p",gap,"notice"));}
  if(result.draft?.rows){const detail=el("details","","delivery-preview"),table=el("table");detail.append(el("summary","查看即将写入的完整表格"));for(const [i,row]of result.draft.rows.entries()){const tr=el("tr");for(const cell of row){const td=el(i===0?"th":"td");td.append(/^https:\/\//.test(cell)?link(cell,cell):el("span",cell));tr.append(td);}table.append(tr);}detail.append(table);root.append(detail);}
  renderTemplateDelivery(root,result,task);
}
function renderTemplateDelivery(root,result,task){
  const delivery=candidateDeliveries.findLast(d=>d.candidate?.task_id===task.id&&d.candidate.result_version===result.result_version&&d.candidate.draft_sha256===result.draft_sha256);
  if(delivery){
    const states={prepared:"子表与字段已核对，等待确认写入",approved:"已确认分表交付",writing:"正在按子表写入并回读",verified:"分表正文与链接已核验",content_verified_links_pending:"分表正文已核验，链接属性待核验",unknown:"部分写入结果需核对，未自动重试",blocked:"交付已停止",cancelled:"交付已取消"};
    root.append(el("h3","腾讯文档分表交付"),el("p",states[delivery.state]||delivery.state,"notice"),el("p",`目标：${delivery.target.url}`,"muted"));
    for(const spec of delivery.templates||[])if(spec.create)root.append(el("p",`分配计划包含新子表「${spec.name}」；字段：${spec.header.join("、")}`,"muted"));
    for(const route of delivery.routes||[]){
      const detail=el("details","","delivery-preview"),table=el("table");
      detail.append(el("summary",`${route.name} · 第 ${route.start_row+1} 行起 · ${route.rows.length} 行`));
      for(const row of route.rows){const tr=el("tr");for(const cell of row){const td=el("td");td.append(/^https:\/\//.test(cell)?link(cell,cell):el("span",cell));tr.append(td);}table.append(tr);}
      detail.append(table);root.append(detail);
      const sheetId=(delivery.receipt?.routes||delivery.receipt?.regions)?.find(r=>r.role===route.role)?.sheet_id||route.sheet_id;
      if(sheetId)root.append(link(`打开${route.name}`,`${delivery.target.url}?tab=${encodeURIComponent(sheetId)}`));
    }
    const sameTarget=destination&&destination.file_id===delivery.target.file_id&&destination.url===delivery.target.url;
    if(delivery.state==="prepared"){
      root.append(el("p","正文按游戏改编或热点联动分别写入；总览保存索引，来源表保存链接和读取范围。已有内容不会直接覆盖。","muted"));
      const approve=button("按上述子表确认写入",async()=>{approve.disabled=true;try{await api(`/api/template-deliveries/${delivery.id}/approve`,{plan_sha256:delivery.plan_sha256,target:structuredClone(destination)});await refreshStatus();}finally{approve.disabled=!sameTarget;}},"primary");approve.disabled=!sameTarget;root.append(approve);
      if(!sameTarget)root.append(el("p","当前设置的目标已变化，请重新核对子表。","notice"));
    }
    if(["approved","writing"].includes(delivery.state))root.append(button("停止交付",async()=>{await api(`/api/template-deliveries/${delivery.id}/cancel`,{});await refreshStatus();}));
    if(["unknown","content_verified_links_pending"].includes(delivery.state))root.append(button("只读核对腾讯内容",async()=>{await api(`/api/template-deliveries/${delivery.id}/reconcile`,{});await refreshStatus();}));
    if(delivery.receipt?.warnings)for(const warning of delivery.receipt.warnings)root.append(el("p",warning==="STYLE_NOT_CERTIFIED"?"字体与单元格样式未单独核验。":warning,"muted"));
  }
  if((!delivery||delivery.state==="prepared")&&task.state==="completed"&&result.status==="needs_review"&&qualityCapabilities?.reviewed_candidate_delivery?.enabled){
    root.append(el("p",destination?`先核对 ${destination.url} 的四个子表与写入位置，再确认交付。核对不会写入或重新分析。`:"请先在连接与交付设置中确认腾讯表格链接。","muted"));
    const prepare=button(delivery?"重新核对子表":"核对腾讯子表与字段",async()=>{if(!destination)throw Error("请先确认腾讯文档链接。");prepare.disabled=true;try{await api("/api/template-deliveries/prepare",{task_id:task.id,result_version:result.result_version,draft_sha256:result.draft_sha256,target:structuredClone(destination)});await refreshStatus();}finally{prepare.disabled=!destination;}},"primary");prepare.disabled=!destination;root.append(prepare);
  }
}
function renderTaskDetail(t) {
  const root = $("task-detail"),
    request = [...(bridge?.pending || []), ...(bridge?.recent || [])].find(
      (r) => r.task_id === t.id && r.kind === "delivery",
    );
  const signature = JSON.stringify([t, request, destination,candidateDeliveries.filter(d=>d.candidate?.task_id===t.id)]);
  if (taskDetailSignature === signature) return;
  taskDetailSignature = signature;
  root.replaceChildren(
    el(
      "h2",
      `${t.payload.game} · ${t.type === "learn" ? "游戏学习" : "策划草稿"}`,
    ),
    el("p", `${t.state_label || t.state} / ${t.stage || "等待执行"}`),
  );
  if (t.error) root.append(el("p", t.error, "notice"));
  if(t.task_store==="creative-candidate"){
    root.append(el("p","基于固定游戏认知与实际原片的创作草稿；腾讯文档须单独审阅确认，交付状态见下方记录。","notice"));
    if(activeStates.includes(t.state))root.append(button("停止创作",async()=>{await api(taskRoute(t,"cancel"),{});await refreshStatus();}));
    if(t.resume_required)root.append(el("p","执行器已中断；刷新不会自动再次分析。保留原任务检查点。","notice"));
    if(t.result)renderCreativeCandidate(root,t.result,t);
    return;
  }
  if(t.task_store==="game-study"){
    root.append(el("p","联网原片的认知候选；代表画面与自动转写不等于完整音画核验。创作和腾讯文档输出单独验收。","notice"));
    if(activeStates.includes(t.state))root.append(button("停止学习",async()=>{await api(taskRoute(t,"cancel"),{});await refreshStatus();}));
    if(t.resume_required)root.append(el("p","此任务尚未在当前执行器启动。返回游戏广场点击继续学习，不会因刷新自动执行。","notice"));
    if(t.result?.draft)renderStudyDossier(root,t.result);
    return;
  }
  if (t.type === "learn" && t.result?.progress) {
    const p = t.result.progress;
    root.append(el("p", `已读取 ${p.read_count || 0} 组 · 相关初学 ${p.relevant_count ?? p.verified_count ?? 0} 组 / 至少 ${p.minimum_required || 20} 组 · 复用 ${p.reused_count || 0} 条`, "notice"));
    if (t.result.summary) addJSON(root, "游戏初步认知与待补充项", {
      summary: t.result.summary, game_overview: t.result.game_overview,
      video_content_map: t.result.video_content_map, initial_quality_notes: t.result.initial_quality_notes,
      sample_coverage: t.result.sample_coverage, unknowns: t.result.unknowns,
      blocking_gaps: t.result.blocking_gaps, version: t.result.version,
    });
  }
  if (
    activeStates.includes(t.state) &&
    (bridge?.pending || []).some((r) => r.task_id === t.id)
  )
    root.append(
      el(
        "p",
        "当前步骤等待助手。请回到当前聊天继续；只打开网页不会自动驱动右侧浏览器。",
        "notice",
      ),
    );
  const plan = t.result?.plan || request?.payload?.plan;
  if (plan) {
    root.append(
      el("h3", "策划草稿"),
      el("p", plan.meaning || ""),
      el("p", plan.rationale || ""),
    );
    for (const idea of plan.ideas || []) {
      root.append(
        el("h4", idea.title),
        el("p", idea.bridge || ""),
        el("p", idea.hook || ""),
        el("pre", idea.script || ""),
      );
      addJSON(root, "分镜与执行素材", {
        shots: idea.shots,
        materials: idea.materials,
        tiers: idea.tiers,
        limitations: idea.limitations,
      });
    }
    addJSON(root, "查看完整策划数据", plan);
  }
  const evidence = t.result?.evidence || request?.payload?.evidence;
  if (evidence) {
    root.append(el("h3", "原片证据与术语核对"));
    for (const item of Array.isArray(evidence) ? evidence : [evidence]) {
      if (item.url)
        root.append(
          link(item.title || "原片 / 来源", item.url, "evidence-link"),
        );
      if (item.kind === "video") {
        const coverage = item.coverage || {};
        const speech =
          coverage.speech === "automatic_transcript_unverified"
            ? "自动转写，尚未核对"
            : ["full_audio_machine_transcription_with_subtitle_point_checks","full_audio_machine_transcription_with_subtitle_alignment"].includes(coverage.speech)
            ? "完整音轨机器转写，不代表完整声音理解"
            : coverage.speech === "no_speech_detected"
            ? "未识别出语音，不代表已理解全部声音"
            : coverage.speech || "未提供语音读取状态";
        const visual = coverage.visual === "uniform_sampled_frames"
          ? `${coverage.sample_count} 张均匀抽帧，未连续观看全部动作`
          : coverage.visual === "uniform_plus_asr_cue_frames"
          ? `${coverage.base_sample_count} 张均匀抽帧与 ${coverage.cue_sample_count} 张线索补帧，未连续观看全部动作`
          : coverage.visual || "未提供读取范围";
        const subtitles = item.subtitle_review?.status === "machine_subtitle_point_checked"
          ? `机器点核，有依据的纠词 ${item.subtitle_review.term_corrections?.length || 0} 项；其余转写未核验，未经人工复核`
          : item.subtitle_review?.status === "aligned_raw_evidence"
          ? "同期字幕与原始语音并列保留，尚未自动纠词"
          : coverage.subtitle_verification || "未提供核对记录";
        const summaryQuality = item.summary_quality?.status === "source_bound"
          ? "按原始文字证据整理；标签为机器初判，未经人工全面复核"
          : item.summary_quality?.status === "consistent"
          ? "抽样OCR与原始ASR机器核对通过；纯画面叙事、动作与构图未复核"
          : item.summary_quality?.status === "needs_review"
          ? "待核验，不计入有效初学"
          : "尚未完成一致性复核";
        root.append(
          el(
            "p",
            `画面：${visual}；语音：${speech}；字幕核对：${subtitles}；摘要：${summaryQuality}。`,
            "notice",
          ),
        );
        if(item.pipeline_version==='extractive-learning-1'){
          root.append(el("p",item.learning_card?.summary||"尚无可用主题"));
          addJSON(root,"范围与限制原文",{scope:item.scope,conditions:item.condition_context});
          addJSON(root,"初步借鉴笔记（本项目判断）",item.learning_notes||[]);
          addJSON(root,"展开机器画面观察（可能有误）",item.analysis?.observations||[]);
        }
        for (const observation of item.pipeline_version==='extractive-learning-1'?[]:item.analysis?.observations || []) {
          const line = el("div", "", "evidence-row");
          line.append(
            el("span", `${observation.time} 秒`),
            el("b", observation.text),
          );
          root.append(line);
        }
        addJSON(
          root,
          "转写原文与时间戳",
          item.transcript?.segments || item.transcript,
        );
        addJSON(
          root,
          "字幕核对与术语修正",
          item.subtitle_review || item.term_corrections || item.corrections,
        );
      }
      addJSON(root, item.title || "证据记录", item);
    }
  }
  if (request?.payload?.draft)
    addJSON(root, "待交付正文与来源链接", request.payload.draft, true);
  if (t.result?.profile) addJSON(root, "已建立的游戏资料", t.result.profile);
  if (t.result?.delivery?.url)
    root.append(
      link("打开已交付腾讯文档 ↗", t.result.delivery.url, "evidence-link"),
    );
  for (const warning of t.result?.delivery?.warnings || [])
    root.append(el("p", warning, "notice"));
  if (request?.state === "awaiting_approval") {
    const actions = el("div", "", "task-detail-actions");
    actions.append(
      el(
        "p",
        destination
          ? `交付目标：${destination.url}。确认后授权助手将上方完整草稿写入此表格。`
          : "请先在连接与交付设置中指定腾讯在线表格。",
      ),
    );
    const approve = button(
      "已审阅草稿，确认交付",
      async () => {
        if (!destination) throw Error("请先保存交付位置。");
        await api(`/api/bridge/${request.id}/approve`, { destination });
        show("已授权本次交付，等待助手通过腾讯文档 MCP 写入并核验。");
        await refreshStatus();
      },
      "primary",
    );
    approve.disabled = !qualityCapabilities?.delivery?.enabled || !destination;
    actions.append(approve);
    root.append(actions);
  } else if (request?.state === "approved")
    root.append(el("p", "本次交付已获授权，等待助手执行。", "notice"));
  else if (request?.state === "writing")
    root.append(
      el("p", "腾讯文档正在写入，完成后将核验正文与交付结果。", "notice"),
    );
  else if (request?.state === "unknown")
    root.append(
      el("p", "写入结果未确认。需先核对腾讯文档，不能直接重复写入。", "notice"),
    );
}
function renderBridge() {
  $("bridge-status").textContent = bridge
    ? `${bridge.mode === "side-browser" ? "右侧浏览器 · 助手协作模式" : "后台模式：" + bridge.mode}。${bridge.pending?.length || 0} 个待处理请求。网站登录和腾讯文档权限需分别验证。`
    : "后台连接状态暂不可用。";
  if (automaticSearch()) {
    $("bridge-status").textContent = `后台自动采集 · ${bridge.collector?.message || bridge.collector?.state || "检查中"}`;
    $("connection-explanation").textContent = "搜索由本机后台采集会话执行。独立网页使用同一份后台数据，登录状态保存在专用会话中。";
    $("connection-login-help").textContent = redfoxMode() ? "红狐 API 获取作品和榜单，腾讯文档使用已有授权及目标链接。" : "启动时检查三个连接，登录失效时重新连接。素材核验和文档写入仍各自保留验证步骤。";
    if (redfoxMode()) $("connection-explanation").textContent = "只在点击开始查询时调用红狐 API；状态刷新不调用收费搜索。无需登录抖音或热点宝。";
  }
}
async function refreshStatus() {
  const results = await Promise.allSettled([
    api("/api/tasks"),
    api("/api/bridge/status"),
    loadProfile(),
    api("/api/quality-policy"),
    api("/api/template-deliveries"),
  ]);
  qualityCapabilities=results[3].status==='fulfilled'?results[3].value.capabilities:null;
  candidateDeliveries=results[4].status==='fulfilled'?results[4].value:[];
  if (results[0].status === "fulfilled") tasks = results[0].value;
  if (results[1].status === "fulfilled") bridge = results[1].value;
  else {
    bridge = null;
    show(results[1].reason, true);
  }
  if (results[0].status === "rejected") show(results[0].reason, true);
  if (automaticSearch()) {
    try { readiness = await api("/api/readiness"); }
    catch { readiness = null; }
    // Poll only local status. The server owns automatic checks; each open
    // client must not independently trigger another source-site navigation.
    renderReadiness();
  }
  renderTasks();
  renderBridge();
  renderGameState();
  renderComposer();
  if (page !== "tasks") await loadRecords();
  updatePageVisibility();
}
let changeTimer;
$("target-game").addEventListener("input", () => {
  gameGeneration++;
  listGeneration++;
  currentProfile = null;
  $("query").value = "";
  sourceMode = "game";
  gameSourceMode = "game";
  $("game-source").classList.add("selected");
  $("game-source").setAttribute("aria-pressed", "true");
  $("courses-source").classList.remove("selected");
  $("courses-source").setAttribute("aria-pressed", "false");
  $("auto-sync").checked = false;
  nextSyncAt = 0;
  $("game-sync-controls").hidden = false;
  $("sync-game").hidden = false;
  $("course-controls").hidden = true;
  $("rank-controls").hidden = true;
  $("fetch-hotspots").hidden = true;
  records = [];
  activeRow = null;
  activeTaskId = null;
  rememberGame();
  if ($("detail-dialog").open) $("detail-dialog").close();
  if ($("task-dialog").open) $("task-dialog").close();
  renderRecords();
  renderPool();
  renderTasks();
  renderGameState();
  $("material-heading").textContent = `${game() || "目标游戏"} · 视频候选`;
  clearTimeout(changeTimer);
  changeTimer = setTimeout(
    async () => {
      const generation = gameGeneration;
      try {
        await Promise.all([loadProfile(), loadRecords()]);
        if (sourceProviders.game !== "redfox" && automaticSearch() && generation === gameGeneration && game()) await searchGame();
      } catch (e) { show(e, true); }
    },
    700,
  );
});
$("learn-game").onclick = () => learning().catch((e) => show(e, true));
$("learning-source").onchange = () => {rememberLearningSource();currentProfile=null;renderGameState();loadProfile().catch(error=>show(error,true));};
$("find-game").onclick = $("sync-game").onclick = () =>
  searchGame().catch((e) => show(e, true));
$("auto-sync").onchange = () => {
  nextSyncAt = Date.now() + 10 * 60 * 1000;
  renderRecords();
};
$("target-game").onkeydown = (event) => {
  if (event.key === "Enter" && sourceProviders.game !== "redfox") searchGame().catch((e) => show(e, true));
};
$("game-source").onclick = () => setSource("game");
$("upload-local-video").onclick=()=>$("local-video-files").click();
$("local-video-files").onchange=event=>{
  const files=Array.from(event.target.files||[]);event.target.value="";
  uploadLocalVideos(files).catch(error=>show(error,true));
};
$("cancel-local-upload").onclick=()=>localUploadController?.abort();
$("courses-source").onclick = () => setSource("courses");
$("open-rankings").onclick = () => {
  $("connection-dialog").close();
  hotspotView = "board";
  switchPage("hotspots");
};
const courseWeekMs = 7 * 86400000;
let courseCheckAt = 0,
  courseRequestBusy = false;
async function requestCourses(manual = true) {
  if (redfoxMode()) { if(manual) show("创作课程的新数据源尚待验证，当前不发起查询。"); return; }
  if (automaticSearch() && !readiness?.ready) { if (manual) renderReadiness(); return; }
  if (courseRequestBusy) return;
  const pending = (bridge?.pending || []).some(
    (r) => r.kind === "search" && r.payload?.purpose === "courses",
  );
  if (pending) {
    if (manual) show(automaticSearch() ? "后台已有课程更新请求，完成后自动显示。" : "已有课程更新请求，等待助手读取实际来源。");
    return;
  }
  courseRequestBusy = true;
  $("fetch-courses").disabled = true;
  try {
    await api("/api/course-search", { keyword: "抖音创作公开课" });
    try {
      localStorage.setItem(
        "crawl-course-request-at",
        JSON.stringify(Date.now()),
      );
    } catch {}
    if (manual)
      show(automaticSearch() ? "后台正在更新创作课程，按周更新，与游戏同步分开。" : "课程更新请求已保存，等待助手执行。课程按周更新，与游戏同步分开。");
    await refreshStatus();
  } finally {
    courseRequestBusy = false;
    $("fetch-courses").disabled = false;
  }
}
async function checkCourseRefresh() {
  if (redfoxMode()) return;
  if (Date.now() < courseCheckAt) return;
  courseCheckAt = Date.now() + 3600000;
  const result = await api("/api/hotspots?collection=courses");
  const times = (result.records || [])
    .map((r) => Date.parse(r.collected_at))
    .filter(Number.isFinite);
  const last = Math.max(
    0,
    ...times,
    Number(localRead("crawl-course-request-at", 0)) || 0,
  );
  if (last && Date.now() - last >= courseWeekMs) await requestCourses(false);
}
$("fetch-courses").onclick = () => requestCourses().catch((e) => show(e, true));
$("local-filter").onclick = $("refresh-list").onclick = () =>
  loadRecords().catch((e) => show(e, true));
$("query").onkeydown = (event) => {
  if (event.key === "Enter") loadRecords().catch((e) => show(e, true));
};
async function requestHotspots() {
  if (hotspotSearchBusy) return;
  if (automaticSearch() && !(sourceProviders.hotspots === "redfox" ? readiness?.hotspot_collection_ready : readiness?.ready)) { renderReadiness(); return; }
  const selected = { ...scope(), keyword: "" };
  if (pendingHotspotRequest()) {
    renderRecords();
    return;
  }
  hotspotSearchBusy = true;
  $("fetch-hotspots").disabled = true;
  try {
    const result = await api("/api/search", {...selected,purpose:"hotspots",user_initiated:true});
    if (sourceMode === "hotspot")
      show(
        result.reused_recent_result ? "已有同范围近期结果，保留原采集时间，本次未重复调用。" : result.queued
          ? (automaticSearch() ? "已提交后台，正在采集所选行业和时间范围。" : "已请求所选范围，等待助手读取热点宝。")
          : "所选范围已同步。",
      );
    await refreshStatus();
  } finally {
    hotspotSearchBusy = false;
    if (sourceMode === "hotspot") renderRecords();
  }
}
$("fetch-hotspots").onclick = () =>
  requestHotspots().catch((e) => show(e, true));
let scopeChangeTimer;
for (const id of ["board", "hours", "category"]) {
  $(id).onchange = () => {
    clearTimeout(scopeChangeTimer);
    ++listGeneration;
    records = [];
    try {
      renderRecords();
    } catch (e) {
      $("cards").replaceChildren();
      cardSignature = "";
      show(e, true);
      return;
    }
    scopeChangeTimer = setTimeout(async () => {
      try {
        await loadRecords();
        if (sourceProviders.hotspots !== "redfox") await requestHotspots();
      } catch (e) {
        show(e, true);
      }
    }, 250);
  };
}
$("sort").onchange = () => loadRecords().catch((e) => show(e, true));
$("save-topic").onclick = () => {
  try {
    if (activeRow) toggleSaved(activeRow);
  } catch (e) {
    show(e, true);
  }
};
$("create-draft").onclick = async () => {
  const candidate=qualityCapabilities?.creative_candidate?.enabled&&qualityCapabilities?.creative_candidate?.configured;
  if(!candidate&&!qualityCapabilities?.creation?.enabled)return;
  const b = $("create-draft");
  const target=game(),generation=gameGeneration;
  b.disabled = true;
  try {
    const selected = pool().find((r) => rowKey(r) === $("draft-source").value);
    if (!selected) throw Error("请先从已确认选题中选择素材。");
    let created;
    if(candidate){
      if(currentProfile?.game!==game()||currentProfile?.learning_source!=="network"||!currentProfile.task_id||!currentProfile.version)throw Error("请先完成当前游戏的联网学习。");
      if(selected.provider!=="redfox"||selected.kind!=="video"||!selected.collection_request_id)throw Error("当前创作入口需要已采集的真实视频和查询批次。");
      created=await api("/api/creative-candidates",{game:game(),mode:$("mode").value,format:$("format").value,study_task_id:currentProfile.task_id,profile_version:currentProfile.version,source:{provider:"redfox",request_id:selected.collection_request_id,source_id:selected.source_id}});
    }else await api("/api/creative-jobs", {
      game: game(),
      source_id: selected.source_id,
      kind: selected.kind,
      mode: $("mode").value,
      format: $("format").value,
    });
    show("策划任务已创建；完成实际核验和草稿后，再确认腾讯文档交付。");
    await refreshStatus();
    if(target!==game()||generation!==gameGeneration)return;
    switchPage("tasks");
    if(created)openTask(created.id);
  } catch (e) {
    show(e, true);
  } finally {
    renderComposer();
  }
};
$("connection-button").onclick = () => $("connection-dialog").showModal();
for (const [id, site] of [["douyin-login", "douyin"], ["douhot-login", "douhot"]]) {
  $(id).onclick = (event) => {
    if (!automaticSearch()) return;
    event.preventDefault();
    $("connection-dialog").close();
    connectCollector(site);
  };
}
$("destination-form").onsubmit = async (event) => {
  event.preventDefault();
  if (pendingDestination) return;
  pendingDestination = true;
  confirmedConnections.delete("tencent"); confirmationRequestedAt.set("tencent", Date.now());
  renderReadiness();
  const b = $("save-settings");
  b.disabled = true;
  try {
    const result = await api("/api/settings", {
      destination: {
        url: $("doc-url").value.trim(),
      },
    });
    destination = result.destination;
    if (result.readiness) { readiness = result.readiness; renderReadiness(); }
    $("destination-status").textContent =
      "交付位置已保存。此操作尚未写入腾讯文档。";
    renderTasks();
  } catch (e) {
    confirmationRequestedAt.delete("tencent");
    $("destination-status").textContent = e.message;
  } finally {
    pendingDestination = false;
    b.disabled = false;
    renderReadiness();
  }
};
document.querySelectorAll("[data-page]").forEach((n) => {
  n.onclick = () => switchPage(n.dataset.page);
});
$("fetch-game-media").onclick = async () => {
  const current = recordCollection;
  if(sourceMode !== "game" || !current?.requested_scope || !matchesCurrentSearch({kind:"search",payload:current.requested_scope}) || current.latest_request?.state !== "fulfilled")
    return show("请先完成当前游戏查询",true);
  await openMediaAcquisition(current.latest_request.id);
};
$("media-acquisition-dialog").addEventListener("close",()=>{mediaGeneration++;clearTimeout(mediaPoll);});
document.querySelectorAll("[data-close]").forEach((n) => {
  n.onclick = () => {
    const dialog = n.closest("dialog");
    if (dialog === materialDialog) closeMaterial();
    else dialog.close();
  };
});
const materialDialog = $("detail-dialog");
function closeMaterial() {
  materialClosing = true;
  materialDialog.close();
}
materialDialog.addEventListener("cancel", (event) => {
  event.preventDefault();
  closeMaterial();
});
materialDialog.addEventListener("close", () => {
  for(const video of $("detail-image").querySelectorAll("video")){video.pause();video.removeAttribute("src");video.load();}
  if (materialHistory && history.state?.crawlMaterial) {
    materialClosing = true;
    history.back();
  } else materialClosing = false;
  materialHistory = false;
});
window.addEventListener("popstate", () => {
  materialHistory = false;
  materialClosing = false;
  if (materialDialog.open) materialDialog.close();
  // Forward navigation must not create an invisible modal history entry.
  if (history.state?.crawlMaterial) history.replaceState(null, "");
});
let materialBackdropDown = false;
function outsideMaterial(event) {
  const r = materialDialog.getBoundingClientRect();
  return (
    event.clientX < r.left ||
    event.clientX > r.right ||
    event.clientY < r.top ||
    event.clientY > r.bottom
  );
}
materialDialog.addEventListener("pointerdown", (event) => {
  materialBackdropDown =
    event.target === materialDialog && outsideMaterial(event);
});
materialDialog.addEventListener("click", (event) => {
  if (
    materialBackdropDown &&
    event.target === materialDialog &&
    outsideMaterial(event)
  )
    closeMaterial();
  materialBackdropDown = false;
});

$("back-discover").onclick = () => {
  hotspotView = "board";
  switchPage("hotspots");
};
$("hotspot-source").onclick = () => {
  hotspotView = "board";
  switchPage("hotspots");
};
$("selected-source").onclick = () => {
  hotspotView = "saved";
  switchPage("hotspots");
};
$("draft-source").onchange = () => {
  const row = pool().find((r) => rowKey(r) === $("draft-source").value);
  if (row) $("mode").value = row.collection === "games" ? "A" : "B";
  renderComposer();
};
$("send-to-task").onclick = () => {
  try {
    if (activeRow) sendToTask(activeRow);
  } catch (e) {
    show(e, true);
  }
};
$("design-button").onclick = () => $("design-dialog").showModal();
try {
  $("target-game").value = localStorage.getItem("crawl-game") || "";
} catch {
  /* retain blank default */
}
renderPool();
renderGameState();
renderRecords();
switchPage("discover");
try {
  const [directory, settings] = await Promise.all([
    api("/api/categories"),
    api("/api/settings"),
  ]);
  sourceProviders = {game:settings.game_source || "browser", hotspots:settings.hotspot_source || "browser"};
  if (redfoxMode()) {
    $("auto-sync").checked = false; $("auto-sync").disabled = true; $("auto-sync").closest("label").hidden = true;
    $("find-game").textContent = "开始查询";
    $("rank-scope-help").textContent = "仅点击开始查询才调用红狐 API，每次1次请求，按当前单价0.6积分。行业按红狐分类，结果为接口返回样本；切换条件和刷新状态不收费。";
    $("board").replaceChildren(new Option("每日热门作品榜", "redfox_daily_hot"));
    $("hours").replaceChildren(new Option("昨日", "24"), new Option("截至昨日 3 天", "72"), new Option("截至昨日 7 天", "168"));
    $("sort").replaceChildren(new Option("点赞从高到低", "heat_desc"), new Option("点赞从低到高", "heat_asc"), new Option("最近取回", "newest"));
    for (const id of ["douyin-login", "douhot-login"]) $(id).hidden = true;
    $("fetch-courses").disabled = true; $("fetch-courses").textContent = "课程接入待验证";
  }
  for (const item of directory.categories || [])
    $("category").append(new Option(item.label, String(item.value)));
  destination = settings.destination || null;
  if (destination) {
    $("doc-url").value = destination.url || "";
  }
  await refreshStatus();
} catch (error) {
  show(error, true);
}
setInterval(async () => {
  if (document.hidden || polling) return;
  polling = true;
  try {
    await refreshStatus();
    await checkCourseRefresh();
    if (sourceProviders.game !== "redfox" && $("auto-sync").checked && game() && Date.now() >= nextSyncAt) {
      nextSyncAt = Date.now() + 10 * 60 * 1000;
      await searchGame();
    }
  } catch (error) {
    show(error, true);
  } finally {
    polling = false;
  }
}, 5000);
