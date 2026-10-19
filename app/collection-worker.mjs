import { randomUUID } from "node:crypto";
import { collectionRecoveryKey } from "./collection-recovery.mjs";
import { normalizeSourceErrorCode } from "./source-errors.mjs";

const LOCK = "automatic-source-collector";
const loginCodes = new Set(["LOGIN_REQUIRED", "VERIFICATION_REQUIRED"]);
const stamp = () => new Date().toISOString();
const sourceCalendarDay = (value) => {
  const time=new Date(value).getTime();
  return Number.isFinite(time) ? new Date(time+8*3600000).toISOString().slice(0,10) : null;
};
const errorText = (error) =>
  String(error?.message || error || "采集失败").slice(0, 500);

// This queue consumes only searches. Media, transcript review and publication
// retain their existing evidence/approval boundaries.
export function startCollectionWorker({
  db,
  bridge,
  store,
  collector,
  enabled = false,
  pollMs = 750,
  timeoutMs = 180000,
  leaseMs = 30000,
  cleanupMs = 5000,
  resumeTimeoutMs = 15000,
  loginVerificationTimeoutMs = 30000,
  minRequestIntervalMs = 0,
  autoStart = true,
  canRun = () => true,
  onConnectionFailure = () => {},
  sourceClock = () => new Date(),
}) {
  const owner = randomUUID();
  let stopped = false,
    active = null,
    loopPromise = null,
    timer = null;
  let loginOpen = false,
    closeFailed = false,
    probing = false,
    checking = false,
    operating = false,
    loginClosing = false,
    loginSessionId = null,
    loginSite = null,
    loginActionPending = 0,
    loginActionChain = Promise.resolve(),
    resumeTask = null,
    sourceResumePending = false,
    verifyingLogin = false;
  db.db.exec(`CREATE TABLE IF NOT EXISTS collection_jobs(
    request_id TEXT PRIMARY KEY, state TEXT NOT NULL, owner TEXT,
    lease INTEGER DEFAULT 0, attempts INTEGER DEFAULT 0,
    error_code TEXT, error_message TEXT, started_at TEXT, finished_at TEXT);
    CREATE TABLE IF NOT EXISTS collection_events(
    id INTEGER PRIMARY KEY, request_id TEXT, state TEXT, detail TEXT, created_at TEXT);`);
  const event = (id, state, detail = null) =>
    db.db
      .prepare(
        "INSERT INTO collection_events(request_id,state,detail,created_at) VALUES(?,?,?,?)",
      )
      .run(id, state, detail, stamp());
  const queue = () =>
    db.db
      .prepare(
        "SELECT id,payload FROM bridge_requests WHERE kind='search' AND state='pending' ORDER BY created_at,rowid",
      )
      .all();
  const blocked = () => db.setting("collector-blocked");
  const nextRequestAt = () => {
    const completed = Date.parse(db.setting("collector-last-completed-at"));
    return Number.isFinite(completed) ? completed + Math.max(0, minRequestIntervalMs) : 0;
  };
  const owns = (id) =>
    Boolean(
      db.db
        .prepare(
          "SELECT request_id FROM collection_jobs WHERE request_id=? AND owner=? AND state='running' AND lease>?",
        )
        .get(id, owner, Date.now()),
    );
  function finish(id, state, code = null, message = null) {
    db.db
      .prepare(
        "UPDATE collection_jobs SET state=?,owner=NULL,lease=0,error_code=?,error_message=?,finished_at=? WHERE request_id=? AND owner=?",
      )
      .run(state, code, message, stamp(), id, owner);
    event(id, state, message);
  }
  async function boundedClose({ operationOnly = false } = {}) {
    let timer;
    try {
      await Promise.race([
        Promise.resolve().then(() =>
          operationOnly && typeof collector.cancelOperation === "function"
            ? collector.cancelOperation()
            : collector.close(),
        ),
        new Promise((_, reject) => {
          timer = setTimeout(
            () => reject(Error(operationOnly ? "采集页面未能及时清理，已暂停后续采集" : "后台浏览器未能及时关闭，请重启创作台")),
            cleanupMs,
          );
        }),
      ]);
      return true;
    } catch (error) {
      closeFailed = true;
      db.setting("collector-blocked", {
        code: "SOURCE_FAILED",
        message: errorText(error),
        at: stamp(),
      });
      return false;
    } finally {
      clearTimeout(timer);
    }
  }
  async function execute(request) {
    const controller = new AbortController();
    active = { request, controller };
    let deadline;
    const heartbeat = setInterval(
      () => {
        bridge.sweep();
        if (
          bridge.get(request.id)?.state !== "pending" ||
          !owns(request.id) ||
          !db.lock(LOCK, owner, leaseMs)
        ) {
          controller.abort(Error("采集请求已取消或租约失效"));
          return;
        }
        db.db
          .prepare(
            "UPDATE collection_jobs SET lease=? WHERE request_id=? AND owner=? AND state='running'",
          )
          .run(Date.now() + leaseMs, request.id, owner);
      },
      Math.max(10, Math.floor(leaseMs / 3)),
    );
    const aborted = new Promise((_, reject) => {
      controller.signal.addEventListener(
        "abort",
        () => reject(controller.signal.reason || Error("采集取消")),
        { once: true },
      );
      deadline = setTimeout(
        () =>
          controller.abort(
            Object.assign(Error("后台采集超时，请重试"), {
              code: "SOURCE_TIMEOUT",
            }),
          ),
        timeoutMs,
      );
    });
    try {
      const result = await Promise.race([
        Promise.resolve().then(() => {
          controller.signal.throwIfAborted();
          // T+1 windows are calendar-based. A queued request cannot silently
          // become a different, newly chargeable query after Beijing midnight.
          if (collector.isIndependentRequest?.(request.payload)) {
            const requestedDay=sourceCalendarDay(request.created_at);
            if (!requestedDay || requestedDay!==sourceCalendarDay(sourceClock()))
              throw Object.assign(Error('查询日期已变化，本次未调用红狐；请重新点击开始查询'),{code:'SOURCE_FAILED'});
          }
          return collector.collect(request.payload, { signal: controller.signal, requestCreatedAt:request.created_at });
        }),
        aborted,
      ]);
      controller.signal.throwIfAborted();
      bridge.sweep();
      if (!owns(request.id) || bridge.get(request.id)?.state !== "pending")
        return;
      // Validate before any store write. A source failure cannot become an empty
      // successful snapshot. Partial reads preserve actual observed coverage.
      if (!result?.records?.length && result?.failures?.length)
        throw Object.assign(Error("来源采集失败，未取得可核验结果"), {
          code: "SOURCE_FAILED",
        });
      const validated = bridge.validate(request, result);
      store.import(validated);
      // Import is idempotent by fingerprint. A crash before fulfillment can
      // retry observation, and cannot invent a successful bridge receipt.
      bridge.fulfill(request.id, {
        request_id: request.id,
        task_id: request.task_id,
        result,
      });
      db.checkpoint("bridge-import:" + request.id, true);
      finish(request.id, "fulfilled");
    } catch (error) {
      const code = normalizeSourceErrorCode(error?.code);
      const message = errorText(error);
      if (owns(request.id)) {
        if (bridge.get(request.id)?.state === "pending" && !stopped)
          bridge.fulfill(request.id, {
            request_id: request.id,
            task_id: request.task_id,
            error: {
              code,
              message,
            },
          });
        finish(request.id, stopped ? "interrupted" : "failed", code, message);
      }
      if (loginCodes.has(code) && !collector.isIndependentRequest?.(request.payload)) {
        const site =
          request.payload.purpose === "hotspots" ? "douhot" : "douyin";
        await onConnectionFailure(site, { code, message });
        db.setting("collector-blocked", {
          code,
          site: request.payload.purpose === "hotspots" ? "douhot" : "douyin",
          message,
          at: stamp(),
        });
      }
      if (error.code === "OPERATION_CLEANUP_FAILED") {
        closeFailed = true;
        db.setting("collector-blocked", {
          code: "OPERATION_CLEANUP_FAILED", message, at: stamp(),
        });
      }
      if (controller.signal.aborted) await boundedClose({ operationOnly: true });
    } finally {
      clearTimeout(deadline);
      clearInterval(heartbeat);
      if (owns(request.id)) finish(request.id, "interrupted");
      active = null;
      db.setting("collector-last-completed-at", stamp());
      db.unlock(LOCK, owner);
    }
  }
  async function runOnce() {
    if (
      !enabled ||
      stopped ||
      active ||
      checking ||
      probing ||
      Date.now() < nextRequestAt()
    )
      return false;
    checking = true;
    let eligible = new Set();
    try {
      bridge.sweep();
      const recoveryScope = (await collector.status?.())?.recovery_scope_key || null;
      for (const row of queue()) {
        const payload=JSON.parse(row.payload);
        if (collector.requestAllowed && !collector.requestAllowed(payload)) continue;
        const independent=Boolean(collector.isIndependentRequest?.(payload));
        // An API request may have spent credits before a crash. Never replay an
        // already-attempted paid request automatically on startup.
        if (independent && db.db.prepare('SELECT request_id FROM collection_jobs WHERE request_id=? AND attempts>0').get(row.id)) continue;
        if (!independent && (loginOpen || closeFailed || blocked() || (recoveryScope && collectionRecoveryKey(payload)!==recoveryScope))) continue;
        if (await canRun(payload)) eligible.add(row.id);
      }
    } finally {
      checking = false;
    }
    if (!eligible.size || stopped || active || probing || operating || sourceResumePending)
      return false;
    bridge.sweep();
    if (!db.lock(LOCK, owner, leaseMs)) return false;
    // Another owner may have completed while canRun was awaiting. Recheck the
    // persisted cooldown under the same lease used to claim the next request.
    if (Date.now() < nextRequestAt()) {
      db.unlock(LOCK, owner);
      return false;
    }
    const request = db.transaction(() => {
      db.db
        .prepare(
          "UPDATE collection_jobs SET state='interrupted',owner=NULL,lease=0 WHERE state='running' AND lease<=?",
        )
        .run(Date.now());
      const entry = queue().find(
        ({ id, payload }) => {
          const independent=Boolean(collector.isIndependentRequest?.(JSON.parse(payload)));
          // canRun and source status await outside this transaction. Another
          // process may have attempted (and paid for) this request meanwhile.
          if (independent && db.db.prepare('SELECT request_id FROM collection_jobs WHERE request_id=? AND attempts>0').get(id)) return false;
          return eligible.has(id) && (independent || !(loginOpen || closeFailed || blocked())) && !db.db
            .prepare(
              "SELECT request_id FROM collection_jobs WHERE request_id=? AND state='running' AND lease>?",
            )
            .get(id, Date.now());
        },
      );
      if (!entry) return null;
      db.db
        .prepare(
          `INSERT INTO collection_jobs(request_id,state,owner,lease,attempts,started_at)
        VALUES(?,'running',?,?,1,?) ON CONFLICT(request_id) DO UPDATE SET state='running',owner=excluded.owner,
        lease=excluded.lease,attempts=collection_jobs.attempts+1,error_code=NULL,error_message=NULL,started_at=excluded.started_at,finished_at=NULL`,
        )
        .run(entry.id, owner, Date.now() + leaseMs, stamp());
      return bridge.get(entry.id);
    });
    if (!request) {
      db.unlock(LOCK, owner);
      return false;
    }
    event(request.id, "running");
    await execute(request);
    return true;
  }
  function kick() {
    if (loopPromise || stopped || !enabled) return;
    loopPromise = runOnce()
      .catch((error) => {
        db.setting("collector-blocked", {
          code: "SOURCE_FAILED",
          message: errorText(error),
          at: stamp(),
        });
        db.unlock(LOCK, owner);
      })
      .finally(() => {
        loopPromise = null;
      });
  }
  async function status() {
    const block = blocked();
    let source;
    try {
      source = await collector.status();
    } catch {
      source = { state: "unavailable" };
    }
    return {
      mode: enabled ? "automatic" : "manual",
      enabled,
      state: !enabled
        ? "disabled"
        : loginOpen
          ? "login_open"
          : block?.code === "VERIFICATION_REQUIRED"
            ? "verification_required"
            : block?.code === "LOGIN_REQUIRED"
              ? "login_required"
              : block
                ? "failed"
                : active
                  ? "running"
                  : "idle",
      active_request_id: active?.request.id || null,
      site: loginOpen ? loginSite : block?.site || null,
      login_session_id: loginOpen ? loginSessionId : null,
      operation:
        verifyingLogin ? "verifying_login" : resumeTask || sourceResumePending
          ? "closing_login"
          : operating
            ? "login_action"
            : probing
              ? "checking_connection"
              : active
                ? "collecting"
                : "idle",
      message: block?.message || null,
      queued: queue().length,
      next_request_at: Date.now() < nextRequestAt() ? new Date(nextRequestAt()).toISOString() : null,
      source,
      recent: db.db
        .prepare(
          "SELECT request_id,state,lease,attempts,error_code,error_message,started_at,finished_at FROM collection_jobs ORDER BY COALESCE(finished_at,started_at) DESC LIMIT 20",
        )
        .all(),
    };
  }
  async function login(site) {
    if (!enabled) throw Error("自动采集未启用");
    const needsCleanup = closeFailed || blocked()?.code === "OPERATION_CLEANUP_FAILED";
    if (!["douyin", "douhot"].includes(site))
      throw Error("只允许登录抖音或热点宝");
    if (loginOpen && loginSite !== site)
      throw Object.assign(Error("请先回创作台确认当前平台连接，再登录另一个平台"), {
        code: "LOGIN_CONFIRM_REQUIRED",
      });
    if (
      active ||
      probing ||
      operating ||
      loginActionPending ||
      loginClosing ||
      sourceResumePending ||
      !db.lock(LOCK, owner, leaseMs)
    )
      throw Object.assign(Error("后台正在执行浏览器操作，请稍后打开登录"), {
        code: "COLLECTOR_BUSY",
      });
    loginOpen = true;
    loginSite = site;
    loginSessionId = randomUUID();
    operating = true;
    const heartbeat = setInterval(
      () => db.lock(LOCK, owner, leaseMs),
      Math.max(10, Math.floor(leaseMs / 3)),
    );
    db.setting("collector-blocked", {
      code: "LOGIN_REQUIRED",
      site,
      message: "登录窗口已打开，完成后请恢复采集",
      at: stamp(),
    });
    try {
      if (needsCleanup) {
        const cleaned = await boundedClose({ operationOnly: true });
        if (!cleaned) throw Object.assign(Error("采集页面尚未清理完成，暂不能打开登录窗口"), {code: "OPERATION_CLEANUP_FAILED"});
        closeFailed = false;
      }
      const result = await collector.login(site, {
        signal: AbortSignal.timeout(timeoutMs),
      });
      return {
        ...(result || {}),
        site,
        state: "login_open",
        login_session_id: loginSessionId,
      };
    } catch (error) {
      loginOpen = false;
      throw error;
    } finally {
      clearInterval(heartbeat);
      operating = false;
      db.unlock(LOCK, owner);
    }
  }
  async function resume(site, sessionId) {
    if (site !== undefined || sessionId !== undefined)
      assertLoginSession(site, sessionId);
    if (resumeTask) return resumeTask;
    if (sourceResumePending)
      throw Object.assign(
        Error("登录会话仍在交接，请稍后重试；持续未结束时请重启创作台"),
        { code: "RESUME_PENDING" },
      );
    loginClosing = true;
    resumeTask = (async () => {
      await loginActionChain;
      return resumeExclusive();
    })().finally(() => {
      loginClosing = false;
      resumeTask = null;
    });
    return resumeTask;
  }
  async function resumeExclusive() {
    if (!enabled) throw Error("自动采集未启用");
    if (active || probing || operating || !db.lock(LOCK, owner, leaseMs))
      throw Object.assign(Error("后台正在执行浏览器操作，请稍后重试"), {
        code: "COLLECTOR_BUSY",
      });
    probing = true;
    const heartbeat = setInterval(
      () => db.lock(LOCK, owner, leaseMs),
      Math.max(10, Math.floor(leaseMs / 3)),
    );
    try {
      if (loginOpen) {
        const expectedSite = loginSite, expectedSession = loginSessionId;
        const controller = new AbortController();
        let timer;
        verifyingLogin = true;
        sourceResumePending = true;
        const verification = Promise.resolve().then(() => {
          if (typeof collector.verifyLogin !== "function")
            throw Object.assign(Error("采集器不支持原生登录核验，请更新创作台"), {code:"LOGIN_CHECK_FAILED"});
          return collector.verifyLogin(expectedSite, {signal:controller.signal});
        }).finally(() => { sourceResumePending = false; verifyingLogin = false; });
        try {
          const evidence = await Promise.race([verification, new Promise((_,reject) => {
            timer = setTimeout(() => {
              const error = Object.assign(Error("当前登录页面核验超时，窗口和会话已保留，请稍后再次确认连接"), {code:"LOGIN_CHECK_TIMEOUT"});
              controller.abort(error);
              reject(error);
            }, Math.min(timeoutMs,loginVerificationTimeoutMs));
          })]);
          controller.signal.throwIfAborted();
          assertLoginSession(expectedSite, expectedSession);
          if (evidence?.site !== expectedSite || !(
            (evidence.state === "ready" && evidence.native_verified === true) ||
            (evidence.state === "window_closed" && evidence.native_verified === false)))
            throw Object.assign(Error("未取得当前页面的本人账号核验结果，登录窗口已保留"), {code:"LOGIN_CHECK_FAILED"});
        } catch (error) {
          const codes = new Set(["LOGIN_REQUIRED","VERIFICATION_REQUIRED","LOGIN_CHECK_FAILED","LOGIN_CHECK_TIMEOUT","LOGIN_SITE_MISMATCH","LOGIN_NOT_OPEN","CLOSE_TIMEOUT","COLLECTOR_BUSY"]);
          const safe = codes.has(error?.code) ? error : Object.assign(Error("当前登录页面核验失败，窗口已保留，请再次确认连接"), {code:"LOGIN_CHECK_FAILED"});
          db.setting("collector-blocked", {code:safe.code,site:expectedSite,message:errorText(safe),at:stamp()});
          throw safe;
        } finally { clearTimeout(timer); }
      }
      const controller = new AbortController();
      let timer;
      sourceResumePending = true;
      const closing = Promise.resolve()
        .then(() => collector.resume({ signal: controller.signal }))
        .finally(() => {
          sourceResumePending = false;
        });
      let handoff;
      try {
        handoff = await Promise.race([
          closing,
          new Promise((_, reject) => {
            timer = setTimeout(
              () => {
                const error = Object.assign(
                  Error(
                    "登录会话交接超时，已保留登录会话；请稍后重试，持续未结束时重启创作台",
                  ),
                  { code: "RESUME_TIMEOUT" },
                );
                controller.abort(error);
                reject(error);
              },
              Math.min(timeoutMs, resumeTimeoutMs),
            );
          }),
        ]);
      } catch (error) {
        if (["RESUME_TIMEOUT", "CLOSE_TIMEOUT"].includes(error?.code)) {
          closeFailed = true;
          db.setting("collector-blocked", {
            code: "SOURCE_FAILED",
            site: loginSite,
            message: error.message,
            at: stamp(),
          });
        }
        throw error;
      } finally {
        clearTimeout(timer);
      }

      const resumedSite = loginSite || blocked()?.site;
      loginOpen = false;
      loginSessionId = null;
      loginSite = null;
      closeFailed = false;
      db.setting("collector-blocked", null);
      const retried = [];
      // Resume at most the latest request for this site (or the exact retained
      // challenge scope). Confirming one login must not replay old game searches
      // or failures from another platform. Task retries have their own lifecycle.
      for (const row of db.db
        .prepare(
          `SELECT b.*,j.error_code FROM bridge_requests b LEFT JOIN collection_jobs j ON j.request_id=b.id
        WHERE b.kind='search' AND b.task_id IS NULL
        ORDER BY b.created_at DESC,b.rowid DESC`,
        )
        .all()) {
        const payload = JSON.parse(row.payload);
        // Browser login confirmation cannot authorize a fresh paid API query.
        if (payload.provider === 'redfox') continue;
        if (!resumedSite || (payload.purpose === "hotspots" ? "douhot" : "douyin") !== resumedSite) continue;
        if (handoff?.retry_scope_key && collectionRecoveryKey(payload) !== handoff.retry_scope_key) continue;
        if (row.state !== "failed" || !loginCodes.has(row.error_code)) break;
        const next = bridge.request("search", payload);
        retried.push(next.id);
        event(row.id, "retry_requested", next.id);
        break;
      }
      return { resumed: true, retried_request_ids: retried };
    } finally {
      clearInterval(heartbeat);
      probing = false;
      db.unlock(LOCK, owner);
      kick();
    }
  }
  function assertLoginSession(site, sessionId) {
    if (!loginOpen)
      throw Object.assign(Error("登录会话尚未打开或已关闭"), {
        code: "LOGIN_NOT_OPEN",
      });
    if (site !== loginSite)
      throw Object.assign(Error("登录站点已切换，请重新打开对应登录页"), {
        code: "LOGIN_SITE_MISMATCH",
      });
    if (typeof sessionId !== "string" || sessionId !== loginSessionId)
      throw Object.assign(Error("登录会话已更新，请重新打开登录页"), {
        code: "LOGIN_SESSION_MISMATCH",
      });
  }
  function loginAction(expectedSite, sessionId, action) {
    try {
      assertLoginSession(expectedSite, sessionId);
    } catch (error) {
      return Promise.reject(error);
    }
    if (!["douyin", "douhot"].includes(expectedSite))
      return Promise.reject(
        Object.assign(Error("登录站点无效"), { code: "LOGIN_INPUT_INVALID" }),
      );
    if (!enabled || !loginOpen || loginClosing || stopped)
      return Promise.reject(
        Object.assign(Error("登录会话尚未打开或正在关闭"), {
          code: "LOGIN_NOT_OPEN",
        }),
      );
    if (loginActionPending >= 8)
      return Promise.reject(
        Object.assign(Error("登录操作较多，请稍后重试"), {
          code: "COLLECTOR_BUSY",
        }),
      );
    loginActionPending++;
    const pending = loginActionChain.then(async () => {
      assertLoginSession(expectedSite, sessionId);
      if (!loginOpen || stopped)
        throw Object.assign(Error("登录会话已关闭"), {
          code: "LOGIN_NOT_OPEN",
        });
      if (active || probing || operating || !db.lock(LOCK, owner, leaseMs))
        throw Object.assign(Error("登录会话忙，请稍后重试"), {
          code: "COLLECTOR_BUSY",
        });
      operating = true;
      const heartbeat = setInterval(
        () => db.lock(LOCK, owner, leaseMs),
        Math.max(10, Math.floor(leaseMs / 3)),
      );
      try {
        const current = await collector.status();
        if (current?.site !== expectedSite)
          throw Object.assign(Error("登录站点已切换，请重新打开对应登录页"), {
            code: "LOGIN_SITE_MISMATCH",
          });
        return await action({
          signal: AbortSignal.timeout(Math.min(timeoutMs, 30000)),
        });
      } catch (error) {
        if (error?.code === "LOGIN_SITE_MISMATCH") throw error;
        if (error?.code === "LOGIN_LOADING")
          throw Object.assign(
            Error("登录授权页面仍在加载，请稍后刷新登录视图"),
            { code: "LOGIN_LOADING" },
          );
        throw Object.assign(Error("登录页面操作未完成，请刷新预览后重试"), {
          code: "LOGIN_ACTION_FAILED",
        });
      } finally {
        clearInterval(heartbeat);
        operating = false;
        db.unlock(LOCK, owner);
      }
    });
    loginActionChain = pending
      .catch(() => {})
      .finally(() => {
        loginActionPending--;
      });
    return pending;
  }
  async function loginView(site, sessionId) {
    return loginAction(site, sessionId, async (options) => {
      const view = await collector.loginView(options);
      const url = new URL(view?.url);
      if (
        url.protocol !== "https:" ||
        url.username ||
        url.password ||
        ![
          "www.douyin.com",
          "douhot.douyin.com",
          "open.douyin.com",
          "passport.douyin.com",
        ].includes(url.hostname) ||
        view?.site !== site ||
        view.width !== 1440 ||
        view.height !== 1000 ||
        typeof view.image !== "string" ||
        view.image.length > 12 * 1024 * 1024 ||
        !/^data:image\/jpeg;base64,[A-Za-z0-9+/]+=*$/.test(view.image)
      )
        throw Error("登录预览格式无效");
      return {
        site: view.site,
        login_session_id: sessionId,
        url: url.origin + url.pathname,
        image: view.image,
        width: view.width,
        height: view.height,
      };
    });
  }
  async function loginInput(site, sessionId, input) {
    const value = validateLoginInput(input);
    return loginAction(site, sessionId, async (options) => {
      await collector.loginInput(value, options);
      return { accepted: true };
    });
  }
  async function probe(site, { signal } = {}) {
    if (!["douyin", "douhot"].includes(site))
      throw Error("只允许检查抖音或热点宝");
    if (collector.isConfigurationProbe?.(site)) return collector.probe(site,{signal});
    if (active || probing || loginOpen || !db.lock(LOCK, owner, leaseMs))
      throw Object.assign(Error("浏览器正在采集或登录，稍后再检查连接"), {
        code: "COLLECTOR_BUSY",
      });
    probing = true;
    const controller = new AbortController();
    const combined = AbortSignal.any([
      controller.signal,
      AbortSignal.timeout(timeoutMs),
      ...(signal ? [signal] : []),
    ]);
    const heartbeat = setInterval(
      () => {
        if (!db.lock(LOCK, owner, leaseMs))
          controller.abort(Error("连接检查租约已失效"));
      },
      Math.max(10, Math.floor(leaseMs / 3)),
    );
    try {
      return await collector.probe(site, { signal: combined });
    } finally {
      clearInterval(heartbeat);
      probing = false;
      db.unlock(LOCK, owner);
    }
  }
  async function stop() {
    stopped = true;
    clearInterval(timer);
    active?.controller.abort(Error("服务停止，采集将在重启后恢复"));
    await loopPromise;
    await boundedClose();
    db.unlock(LOCK, owner);
  }
  if (enabled && autoStart) {
    timer = setInterval(kick, pollMs);
    timer.unref();
    kick();
  }
  return {
    status,
    kick,
    runOnce,
    login,
    resume,
    loginView,
    loginInput,
    probe,
    stop,
  };
}

export function validateLoginInput(value) {
  const invalid = () => {
    throw Object.assign(Error("登录输入格式无效"), {
      code: "LOGIN_INPUT_INVALID",
    });
  };
  if (!value || typeof value !== "object" || Array.isArray(value))
    return invalid();
  const keys = Object.keys(value).sort().join(",");
  if (
    value.type === "click" &&
    keys === "type,x,y" &&
    Number.isFinite(value.x) &&
    Number.isFinite(value.y) &&
    value.x >= 0 &&
    value.x < 1440 &&
    value.y >= 0 &&
    value.y < 1000
  )
    return { type: "click", x: value.x, y: value.y };
  if (
    value.type === "pointer" &&
    keys === "phase,type,x,y" &&
    ["down", "move", "up"].includes(value.phase) &&
    Number.isFinite(value.x) &&
    value.x >= 0 &&
    value.x < 1440 &&
    Number.isFinite(value.y) &&
    value.y >= 0 &&
    value.y < 1000
  )
    return { type: "pointer", phase: value.phase, x: value.x, y: value.y };
  if (
    value.type === "drag" &&
    keys === "fromX,fromY,toX,toY,type" &&
    [value.fromX, value.toX].every(
      (v) => Number.isFinite(v) && v >= 0 && v < 1440,
    ) &&
    [value.fromY, value.toY].every(
      (v) => Number.isFinite(v) && v >= 0 && v < 1000,
    )
  )
    return {
      type: "drag",
      fromX: value.fromX,
      fromY: value.fromY,
      toX: value.toX,
      toY: value.toY,
    };
  if (
    value.type === "scroll" &&
    keys === "deltaY,type" &&
    Number.isFinite(value.deltaY) &&
    Math.abs(value.deltaY) <= 2000
  )
    return { type: "scroll", deltaY: value.deltaY };
  if (
    value.type === "text" &&
    keys === "text,type" &&
    typeof value.text === "string" &&
    value.text.length > 0 &&
    value.text.length <= 2000 &&
    !/[\x00-\x1f\x7f]/.test(value.text)
  )
    return { type: "text", text: value.text };
  if (
    value.type === "key" &&
    keys === "key,type" &&
    [
      "Enter",
      "Tab",
      "Backspace",
      "ArrowLeft",
      "ArrowRight",
      "ArrowUp",
      "ArrowDown",
      "Escape",
    ].includes(value.key)
  )
    return { type: "key", key: value.key };
  return invalid();
}
