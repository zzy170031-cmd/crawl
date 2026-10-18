import { randomUUID } from "node:crypto";
import { Model } from "./model.mjs";
import { searchSource } from "./search.mjs";
import { inspectMedia, internetSources, diversify } from "./media.mjs";
import {
  profileSchema,
  planSchema,
  validateProfile,
  validatePlan,
} from "./contracts.mjs";
import { hash } from "./tasks.mjs";
import { deliver } from "./delivery.mjs";
export class NeedsInput extends Error {}
export function startWorker(
  db,
  {
    model = new Model(),
    search = searchSource,
    readMedia = inspectMedia,
    web = internetSources,
    publish = deliver,
    interval = 1500,
  } = {},
) {
  const owner = randomUUID();
  let active = null,
    stopped = false,
    controller = null;
  async function tick() {
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
    const ctx = { db, model, signal, stage };
    async function cached(key, fn) {
      let result = db.checkpoint(key);
      if (!result) {
        result = await fn();
        db.checkpoint(key, result);
      }
      return result;
    }
    try {
      ctx.identity = await model.identity();
      const game = task.payload.game;
      const p = task.payload;
      const own = (fn) => withBrowser(db, owner, fn, signal);
      if (task.type === "learn") {
        stage("寻找游戏热门作品");
        const candidates = await cached("samples:" + task.id, async () => {
          const results = [];
          for (const hours of [24, 168])
            for (const board of [1001, 1002]) {
              try {
                results.push(
                  ...(await own(() => search({ keyword: game, hours, board })))
                    .records,
                );
              } catch (e) {
                signal.throwIfAborted();
              }
            }
          return diversify(results, 5);
        });
        if (candidates.length < 3)
          throw new NeedsInput(
            "游戏相关视频候选不足3条，请检查来源或补充具体作品",
          );
        const evidence = [];
        for (const row of candidates)
          evidence.push(await own(() => readMedia(row, ctx)));
        stage("查阅互联网游戏资料");
        evidence.push(
          ...(await cached("web:" + task.id, () =>
            own(() => web(game, { signal })),
          )),
        );
        if (!evidence.some((e) => e.kind === "web"))
          throw new NeedsInput(
            "未取得可读游戏资料，不能仅靠标题或模型记忆建立游戏知识",
          );
        stage("整理游戏资料库");
        const value = await model.json(
          "根据实际视频阅读和网页资料建立游戏研究。先排除只挂标签/其他游戏，至少3条独立相关作品。创作手法和玩家关注点引用视频；机制须引用可靠游戏资料，不从宣传片演绎当实装。不是爆款成因证明。游戏名保持输入。",
          { game, evidence },
          profileSchema,
          { signal },
        );
        validateProfile(value, evidence, game);
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
          evidence,
          version: hash({ value, evidence }),
          created_at: new Date().toISOString(),
          expires_at: new Date(Date.now() + 7 * 86400000).toISOString(),
          status: "ready",
          coverage: "抽样画面与自动语音；结论限定已读证据，不代表完整视听核验",
        };
        db.profile(game, profile);
        db.finish(task.id, owner, "completed", profile);
      } else if (task.type === "create") {
        const profile = db.profile(game);
        if (!profile || Date.parse(profile.expires_at) < Date.now())
          throw new NeedsInput("请先完成或更新目标游戏学习");
        if (p.profile_version && p.profile_version !== profile.version)
          throw new NeedsInput("游戏资料版本已变化，请以新版本重新确认选题");
        stage("解析热点代表视频");
        const rows = await cached("hotspots:" + task.id, async () => {
          const list = [];
          if (p.source.kind === "video") list.push(p.source);
          const keyword = (
            p.source.title.split("#")[0].trim() || p.source.title
          ).slice(0, 80);
          const result = await own(() =>
            search({ keyword, hours: 24, board: 1001 }),
          );
          for (const r of result.records)
            if (r.source_id !== p.source.source_id) list.push(r);
          const selected = diversify(list, 3);
          if (
            p.source.kind === "video" &&
            !selected.some((r) => r.source_id === p.source.source_id)
          )
            selected.splice(0, 1, p.source);
          return selected;
        });
        if (!rows.length || (p.mode === "B" && rows.length < 2))
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
                evidence,
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
        stage("同步完整策划到腾讯文档");
        const receipt = await publish({ task, plan, evidence, db, signal });
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
            : e instanceof NeedsInput
              ? "needs_input"
              : "failed",
          null,
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
