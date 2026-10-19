import { randomUUID } from "node:crypto";
import { Model } from "./model.mjs";
import { searchSource } from "./search.mjs";
import {
  inspectMedia,
  internetSources,
  diversify,
  mediaFingerprint,
} from "./media.mjs";
import {
  profileSchema,
  planSchema,
  validateProfile,
  validatePlan,
} from "./contracts.mjs";
import { hash } from "./tasks.mjs";
import { deliver, composeRows } from "./delivery.mjs";
import { config } from "./config.mjs";
import { SideBridge } from "./side-bridge.mjs";
import { ContentGroups } from "./content-groups.mjs";
import { MediaUnavailableError } from "./media-unavailable.mjs";
import { LearningSnapshotError, resolveBoundGameCollection } from "./learning-snapshot.mjs";
import { RedfoxAssetError } from "./redfox-assets.mjs";
import { runGameLearning } from "./game-learning.mjs";
export class NeedsInput extends Error {}
export function startWorker(
  db,
  {
    model = new Model(),
    search = searchSource,
    readMedia = inspectMedia,
    fingerprintMedia = mediaFingerprint,
    web = internetSources,
    publish = deliver,
    interval = 1500,
    browserMode = config.browserMode,
    gameProvider = config.gameSource,
    bridge = new SideBridge(db),
    groups = new ContentGroups(db),
    canRun = () => true,
    preliminaryLearning = readMedia === inspectMedia ? runGameLearning : null,
  } = {},
) {
  const owner = randomUUID();
  let active = null,
    stopped = false,
    controller = null;
  async function tick() {
    if (active || stopped || !(await canRun())) return;
    if (active || stopped || !db.lock("worker", owner)) return;
    const task = db.claim(owner);
    if (!task) {
      db.unlock("worker", owner);
      return;
    }
    active = task;
    controller = new AbortController();
    let lost = false;
    const heartbeat = setInterval(() => {
      if (!db.heartbeat(task.id, owner) || !db.lock("worker", owner)) {
        lost = true;
        controller.abort(Error("任务执行权已失效"));
      }
      if (db.get(task.id)?.cancelled) controller.abort(Error("用户已取消"));
    }, 1000);
    const signal = controller.signal;
    const stage = (s) => {
      signal.throwIfAborted();
      db.stage(task.id, owner, s);
    };
    const ctx = {
      db,
      model,
      signal,
      stage,
      bridge,
      browserMode,
      taskId: task.id,
      reviewRevision: randomUUID(),
    };
    const bridgeSearch = (args) =>
      bridge.wait(bridge.request("search", args, { taskId: task.id }), {
        signal,
      });
    const runSearch = browserMode === "side-browser" ? bridgeSearch : search;
    async function cached(key, fn, usable = (value) => Boolean(value)) {
      let result = db.checkpoint(key);
      if (!usable(result)) {
        result = await fn();
        db.checkpoint(key, result);
      }
      return result;
    }
    try {
      // Recover a verified external receipt before any model/source work. The
      // already delivered plan must never be regenerated on retry.
      const completedDelivery =
        (browserMode === "side-browser" || task.payload.source?.provider === 'redfox') && task.type === "create"
          ? bridge.completedDelivery?.(task.id)
          : null;
      if (completedDelivery) {
        const { plan, evidence } = completedDelivery.payload;
        const receipt = completedDelivery.result;
        db.finish(
          task.id,
          owner,
          receipt.warnings?.length ? "completed_with_warnings" : "completed",
          { plan, evidence, delivery: receipt },
        );
        return;
      }
      const learningSnapshot = task.type === "learn" && (gameProvider === "redfox" || task.payload.source_provider === "redfox")
        ? resolveBoundGameCollection(bridge,task.payload) : null;
      ctx.identity = await model.identity();
      const game = task.payload.game;
      if (learningSnapshot && preliminaryLearning) {
        const profile = await preliminaryLearning(learningSnapshot, {
          ...ctx, game, groups,
          saveProgress: result => db.db.prepare("UPDATE tasks SET result=? WHERE id=? AND owner=? AND state='running'").run(JSON.stringify(result),task.id,owner),
        });
        db.finish(task.id,owner,profile.status === 'ready' ? 'completed' : 'needs_input',profile,profile.status === 'ready' ? null : profile.blocking_gaps.join('；'));
        return;
      }
      const p = task.payload;
      const requiredVideos = 20;
      const targetVideos = 30;
      const own = (fn) =>
        browserMode === "side-browser"
          ? fn()
          : withBrowser(db, owner, fn, signal);
      const usableEvidence = (e) =>
        Boolean(
          e?.analysis &&
            !e.analysis.needs_audio_review &&
            !e.analysis.blocking_gaps?.length &&
            (browserMode !== "side-browser" ||
              ["reviewed_no_changes", "reviewed_with_corrections"].includes(
                e.subtitle_review?.status,
              )),
        );
      const reusableEvidence = (e) =>
        usableEvidence(e) &&
        ["reviewed_no_changes", "reviewed_with_corrections"].includes(
          e.subtitle_review?.status,
        );
      if (task.type === "learn") {
        stage(learningSnapshot ? "读取已绑定的游戏查询结果" : "寻找游戏热门作品");
        const candidates = diversify(
          groups.annotate(
            learningSnapshot ? learningSnapshot.records : await cached(
              "samples:" + task.id,
              async () => {
                if (browserMode === "side-browser") {
                  stage("等待助手在右侧抖音搜索游戏作品");
                  const found = await runSearch({
                    keyword: game,
                    hours: 4320,
                    board: null,
                    sort: "relevance",
                    purpose: "game-learning",
                  });
                  const oldSamples = db.checkpoint("samples:" + task.id) || [];
                  const retained = oldSamples.filter((row) =>
                    usableEvidence(
                      db.checkpoint(
                        "video-evidence:" + task.id + ":" + row.source_id,
                      ),
                    ),
                  );
                  const selected = diversify(
                    groups.annotate([
                      ...found.records,
                      ...retained,
                      ...oldSamples,
                    ]),
                    targetVideos,
                  );
                  if (selected.length < requiredVideos) {
                    db.checkpoint("samples:" + task.id, selected);
                    db.db
                      .prepare(
                        "UPDATE tasks SET result=? WHERE id=? AND owner=? AND state='running'",
                      )
                      .run(
                        JSON.stringify({
                          progress: {
                            candidate_count: selected.length,
                            read_count: 0,
                            verified_count: 0,
                            minimum_required: requiredVideos,
                            target: targetVideos,
                            total_to_read: selected.length,
                          },
                        }),
                        task.id,
                        owner,
                      );
                    throw new NeedsInput(
                      `实际搜索取得${selected.length}条独立作品，完整学习至少需要${requiredVideos}条，目标池${targetVideos}条；请补充实际作品，不代表游戏不热门`,
                    );
                  }
                  return selected;
                }
                const results = [];
                const failures = [];
                for (const hours of [24, 168])
                  for (const board of [1001, 1002]) {
                    try {
                      results.push(
                        ...(
                          await own(() =>
                            search({ keyword: game, hours, board }),
                          )
                        ).records,
                      );
                    } catch (e) {
                      signal.throwIfAborted();
                      failures.push(e.code || "SOURCE_FAILED");
                    }
                  }
                const selected = diversify(
                  groups.annotate(results),
                  targetVideos,
                );
                if (selected.length < requiredVideos) {
                  if (failures.length) {
                    if (
                      failures.every((code) => code === "BROWSER_UNAVAILABLE")
                    )
                      throw Error(
                        "后台未连接到专用浏览器；右侧浏览器登录尚未接入后台采集。不能据此判断游戏没有内容。",
                      );
                    throw Error(
                      `游戏素材检索未完成：${failures.length}/4 次榜单查询失败，请检查来源连接或登录；不能据此判断游戏没有内容。`,
                    );
                  }
                  throw new NeedsInput(
                    "当前热点榜单首屏找到的独立游戏作品不足20条；这不是抖音全站搜索，不代表游戏不热门。请在抖音搜索具体游戏作品。",
                  );
                }
                return selected;
              },
              (value) =>
                Array.isArray(value) &&
                groups.independentCount(value) >= requiredVideos &&
                !task.result?.progress,
            ),
          ),
          targetVideos,
        );
        if (learningSnapshot && groups.independentCount(candidates) < requiredVideos)
          throw new NeedsInput(`本次查询仅有${groups.independentCount(candidates)}组独立候选，学习至少需要${requiredVideos}组；请回游戏广场补充查询，不会自动收费补搜`);
        const evidence = [];
        const unavailable_sources = [];
        const progress = {
          candidate_count: candidates.length,
          read_count: 0,
          verified_count: 0,
          minimum_required: requiredVideos,
          target: targetVideos,
          total_to_read: candidates.length,
          reused_count: 0,
          newly_read_count: 0,
          unavailable_count: 0,
          unavailable_source_count: 0,
        };
        const saveProgress = () =>
          db.db
            .prepare(
              "UPDATE tasks SET result=? WHERE id=? AND owner=? AND state='running'",
            )
            .run(
              JSON.stringify({ progress, evidence, unavailable_sources }),
              task.id,
              owner,
            );
        saveProgress();
        for (const row of candidates) {
          if (evidence.some((e) => groups.key(e) === groups.key(row))) continue;
          const fingerprint = await fingerprintMedia(row, {
            identity: ctx.identity,
            browserMode,
          });
          const reusable = db.checkpoint("verified-media:" + row.source_id);
          let observed;
          if (
            fingerprint &&
            reusable?.fingerprint === fingerprint &&
            reusableEvidence(reusable.evidence)
          ) {
            observed = {
              ...reusable.evidence,
              reused_from: {
                task_id: reusable.task_id,
                read_at: reusable.evidence.read_at,
                media_fingerprint: fingerprint,
                scope:
                  "复用未变的本地音画与核验产物；保留原读取时间，本次未重新下载核验远端内容",
              },
              current_source_observation: {
                collected_at: row.collected_at || null,
                like_count: row.like_count ?? null,
                scope: row.scope || null,
              },
            };
            progress.reused_count++;
          } else {
            let freshlyRead = false;
            try {
              observed = await cached(
                "video-evidence:" + task.id + ":" + row.source_id,
                () => {
                  freshlyRead = true;
                  return own(() => readMedia(row, ctx));
                },
                // Cross-task reuse requires current content fingerprints. The
                // task cache is only a recovery aid for unchanged verified files.
                (value) =>
                  usableEvidence(value) &&
                  fingerprint &&
                  value.media_fingerprint === fingerprint,
              );
            } catch (error) {
              signal.throwIfAborted();
              if (!(error instanceof MediaUnavailableError)) throw error;
              if (error.observation.source_id !== row.source_id)
                throw Error("不可读观察与当前候选身份不符");
              unavailable_sources.push(error.observation);
              db.checkpoint(
                "unavailable-media:" + task.id + ":" + row.source_id,
                error.observation,
              );
              progress.unavailable_source_count = unavailable_sources.length;
              progress.unavailable_count =
                groups.independentCount(unavailable_sources);
              stage("记录不可读候选并继续 " + row.source_id);
              saveProgress();
              continue;
            }
            if (!freshlyRead) observed = {
              ...observed,
              reused_from: {
                task_id: task.id,
                read_at: observed.read_at,
                media_fingerprint: fingerprint,
                scope: "恢复本任务已核验的音画检查点；保留原读取时间，本次未重新读取",
              },
              current_source_observation: {
                collected_at: row.collected_at || null,
                like_count: row.like_count ?? null,
                scope: row.scope || null,
              },
            };
            const after = await fingerprintMedia(row, {
              identity: ctx.identity,
              browserMode,
            });
            if (after) observed = { ...observed, media_fingerprint: after };
            db.checkpoint(
              "video-evidence:" + task.id + ":" + row.source_id,
              observed,
            );
            if (after && reusableEvidence(observed))
              db.checkpoint("verified-media:" + row.source_id, {
                fingerprint: after,
                evidence: observed,
                task_id: task.id,
                stored_at: new Date().toISOString(),
              });
            if (freshlyRead) progress.newly_read_count++;
            else progress.reused_count++;
          }
          evidence.push(observed);
          progress.read_source_count = evidence.length;
          progress.read_count = groups.independentCount(evidence);
          progress.total_to_read = groups.independentCount(candidates);
          progress.verified_count = groups.independentCount(
            evidence.filter(
              (e) =>
                !e.analysis.needs_audio_review &&
                !e.analysis.blocking_gaps.length &&
                (browserMode !== "side-browser" ||
                  ["reviewed_no_changes", "reviewed_with_corrections"].includes(
                    e.subtitle_review?.status,
                  )),
            ),
          );
          saveProgress();
        }
        if (progress.verified_count < requiredVideos)
          throw new NeedsInput(
            `已读${progress.read_count}条，通过音画与术语复核${progress.verified_count}条，尚不足${requiredVideos}条有效学习证据`,
          );
        stage("查阅互联网游戏资料");
        evidence.push(
          ...(await cached(
            "web:" + task.id,
            () =>
              own(() =>
                web(game, { signal, bridge, browserMode, taskId: task.id }),
              ),
            (value) => Array.isArray(value) && value.length > 0,
          )),
        );
        if (!evidence.some((e) => e.kind === "web"))
          throw new NeedsInput(
            "未取得可读游戏资料，不能仅靠标题或模型记忆建立游戏知识",
          );
        stage("整理游戏资料库");
        const value = await model.json(
          `根据实际视频阅读和网页资料建立游戏研究。先排除只挂标签/其他游戏，至少${requiredVideos}条独立相关作品。创作手法和玩家关注点引用视频；机制须引用可靠游戏资料，不从宣传片演绎当实装。不是爆款成因证明。游戏名保持输入。`,
          {
            game,
            evidence: evidence.map(
              ({ transcript, subtitle_review, ...e }) => e,
            ),
          },
          profileSchema,
          { signal },
        );
        validateProfile(value, evidence, game);
        if (groups.independentCount(value.relevant_video_ids) < requiredVideos)
          throw new NeedsInput(
            `实际相关作品不足${requiredVideos}条，保留已读证据继续补充，不能将标题候选数当学习完成`,
          );
        const relevant = evidence.filter((e) =>
          value.relevant_video_ids.includes(e.id),
        );
        const gaps = [
          ...value.blocking_gaps,
          ...relevant.flatMap((e) => e.analysis.blocking_gaps),
        ];
        if (gaps.length || relevant.some((e) => e.analysis.needs_audio_review))
          throw new NeedsInput(
            "需要补读关键内容：" + gaps.join("；") + "；必要音画信息尚未核验",
          );
        for (const c of value.game_facts)
          if (
            !c.evidence_ids.some(
              (id) => evidence.find((e) => e.id === id)?.kind === "web",
            )
          )
            throw new NeedsInput("游戏事实缺少互联网资料依据");
        const profile = {
          ...value,
          ...(learningSnapshot ? {collection_origin:learningSnapshot.provenance} : {}),
          evidence,
          unavailable_sources,
          version: hash({ value, evidence }),
          created_at: new Date().toISOString(),
          expires_at: new Date(Date.now() + 7 * 86400000).toISOString(),
          status: "ready",
          progress,
          independent_content_count: groups.independentCount(
            value.relevant_video_ids,
          ),
          coverage: "抽样画面与自动语音；结论限定已读证据，不代表完整视听核验",
        };
        db.profile(game, profile);
        db.finish(task.id, owner, "completed", profile);
      } else if (task.type === "create") {
        const profile = db.profile(game);
        if (
          !profile ||
          profile.status !== "ready" ||
          Date.parse(profile.expires_at) < Date.now() ||
          groups.independentCount(profile.relevant_video_ids || []) < 20
        )
          throw new NeedsInput("请先完成或更新目标游戏学习");
        if (p.profile_version && p.profile_version !== profile.version)
          throw new NeedsInput("游戏资料版本已变化，请以新版本重新确认选题");
        stage("解析热点代表视频");
        const rows = await cached("hotspots:" + task.id, async () => {
          const list = [];
          if (p.source.kind === "video") list.push(p.source);
          // A selected Redfox work is already the confirmed topic. Related
          // works must be selected upstream; creation may not issue a search.
          if (p.source.provider === 'redfox') return list;
          const keyword = (
            p.source.title.split("#")[0].trim() || p.source.title
          ).slice(0, 80);
          const result = await own(() =>
            runSearch({
              keyword,
              hours: 24,
              board: browserMode === "side-browser" ? null : 1001,
              purpose:
                browserMode === "side-browser" ? "related-work" : "hotspots",
              target_game: game,
            }),
          );
          for (const r of result.records)
            if (r.source_id !== p.source.source_id) list.push(r);
          const selected = diversify(groups.annotate(list), 3);
          if (
            p.source.kind === "video" &&
            !selected.some((r) => r.source_id === p.source.source_id)
          )
            selected.splice(0, 1, p.source);
          return selected;
        });
        if (!rows.length || (p.source.provider !== 'redfox' && p.mode === "B" && rows.length < 2))
          throw new NeedsInput(
            "当前榜单查询未找到足够代表原片；热点联动需至少2条，搜索入口不能代替视频",
          );
        const hot = [];
        for (const row of rows)
          hot.push({
            ...(await own(() => readMedia(row, ctx))),
            role: "hotspot",
          });
        if (
          hot.some(
            (e) =>
              e.analysis.needs_audio_review || e.analysis.blocking_gaps.length,
          )
        )
          throw new NeedsInput("热点关键内容读取不足，需要补充原片或核验声音");
        const evidence = [
          ...hot,
          ...profile.evidence
            .filter(
              (e) =>
                e.kind !== "video" || profile.relevant_video_ids.includes(e.id),
            )
            .map((e) => ({ ...e, role: "game" })),
        ];
        stage("热点与游戏结合");
        const key =
          "plan:" +
          hash({
            task: task.id,
            profile: profile.version,
            evidence,
            identity: ctx.identity,
            prompt: 3,
          });
        const { evidence: profileEvidence, ...profileSummary } = profile;
        const plan = await cached(key, async () =>
          validatePlan(
            await model.json(
              "只做A爆款改编或B热点联动，不做常态指南。先判断热点代表作品确实在讲用户选题，若不相关或语境缺失设insufficient。依据已读内容与游戏资料，分别考虑直接结合、玩家处境、表达手法借用，不按标题字词套模板。游戏机制和人物不可以从其他游戏移植。输出约3个实质不同方案，每案完整原创台词/文案、分镜(或图文页)、素材、低中高投入与观看收益，不能只留提纲。A另保留原片结构迁移。没有素材的方案标待补，未验证玩法不得写成事实。引用只能使用给定evidence id；整体和每案evidence_ids都必须同时包含role为hotspot的原片与role为game的游戏依据。",
              {
                mode: p.mode,
                format: p.format,
                game,
                topic: p.source.title,
                profile: profileSummary,
                evidence: evidence.map(
                  ({ transcript, subtitle_review, ...e }) => e,
                ),
              },
              planSchema,
              { signal },
            ),
            evidence,
            game,
          ),
        );
        validatePlan(plan, evidence, game);
        if (
          ["insufficient", "unsuitable"].includes(plan.fit) ||
          plan.blocking_gaps.length
        ) {
          db.finish(
            task.id,
            owner,
            "needs_input",
            { plan, evidence },
            "当前方案不满足自动交付条件",
          );
          return;
        }
        let receipt;
        if (browserMode === "side-browser" || p.source.provider === 'redfox') {
          stage("草稿已完成，等待确认腾讯文档交付目标");
          const request = bridge.request(
            "delivery",
            {
              game,
              plan,
              evidence,
              draft: composeRows(task, plan, evidence),
              destination: p.destination || null,
            },
            { taskId: task.id },
          );
          db.db
            .prepare(
              "UPDATE tasks SET result=? WHERE id=? AND owner=? AND state='running'",
            )
            .run(
              JSON.stringify({ plan, evidence, bridge_request_id: request.id }),
              task.id,
              owner,
            );
          receipt = await bridge.wait(request, { signal });
        } else {
          stage("同步完整策划到腾讯文档");
          receipt = await publish({ task, plan, evidence, db, signal });
        }
        db.finish(
          task.id,
          owner,
          receipt.warnings?.length ? "completed_with_warnings" : "completed",
          { plan, evidence, delivery: receipt },
        );
      } else throw Error("未知任务类型");
    } catch (e) {
      if (!lost)
        db.finish(
          task.id,
          owner,
          signal.aborted
            ? "cancelled"
            : e instanceof NeedsInput ||
                e instanceof LearningSnapshotError ||
                e instanceof RedfoxAssetError ||
                e.code === "DELIVERY_UNKNOWN" ||
                e.code === "BRIDGE_EXPIRED" ||
                e instanceof MediaUnavailableError
              ? "needs_input"
              : "failed",
          db.get(task.id)?.result || null,
          String(e.message).slice(0, 1500),
        );
    } finally {
      clearInterval(heartbeat);
      db.unlock("worker", owner);
      active = null;
      controller = null;
    }
  }
  const timer = setInterval(() => tick().catch(() => {}), interval);
  return {
    tick,
    stop() {
      stopped = true;
      clearInterval(timer);
      controller?.abort(Error("服务停止"));
    },
    active: () => active?.id,
  };
}
export async function withBrowser(db, owner, fn, signal) {
  if (!db.lock("browser", owner))
    throw Error("浏览器正在读取其他媒体，请稍后重试");
  let lost = false;
  const timer = setInterval(() => {
    if (!db.lock("browser", owner)) lost = true;
  }, 5000);
  try {
    signal?.throwIfAborted();
    const result = await fn();
    if (lost) throw Error("浏览器租约失效");
    signal?.throwIfAborted();
    return result;
  } finally {
    clearInterval(timer);
    db.unlock("browser", owner);
  }
}
