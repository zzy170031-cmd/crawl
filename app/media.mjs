import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { readFile, access } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright-core";
import { config, mediaURL, dataDir, root } from "./config.mjs";
import { hash } from "./tasks.mjs";
import { mediaSchema, validateSchema } from "./contracts.mjs";
const exec = promisify(execFile);
const exists = async (p) => {
  try {
    await access(p);
    return true;
  } catch {
    return false;
  }
};
async function script(name, args, signal) {
  try {
    await exec(
      name.endsWith(".py") ? config.python : process.execPath,
      [fileURLToPath(new URL(name, import.meta.url)), ...args],
      {
        cwd: root,
        env: { ...process.env, CRAWL_DATA_DIR: dataDir },
        signal,
        timeout: 300000,
        windowsHide: true,
        maxBuffer: 2 * 1024 * 1024,
      },
    );
  } catch (e) {
    if (signal?.aborted) throw signal.reason;
    throw Error(
      "媒体步骤 " +
        name +
        " 失败：" +
        String(e.stderr || e.message).slice(-700),
    );
  }
}
export async function inspectMedia(
  row,
  { db, model, signal, stage, identity },
) {
  const id = row.source_id;
  if (row.kind !== "video" || !/^\d{10,25}$/.test(id))
    throw Error("需要具体视频作品，不能将话题或搜索页当原片");
  const folder = mediaURL(id);
  const framesFile = new URL("frames.json", folder),
    pageFile = new URL("page.json", folder);
  stage("读取原片画面 " + id);
  if (!(await exists(framesFile)) || !(await exists(pageFile)))
    await script("inspect-source-page.mjs", [id, "--frames"], signal);
  const frames = JSON.parse(await readFile(framesFile, "utf8"));
  const page = JSON.parse(await readFile(pageFile, "utf8"));
  if (
    new URL(page.url).pathname !== `/video/${id}` ||
    !page.title ||
    !frames.frames.length
  )
    throw Error("媒体身份不一致");
  stage("读取原片语音 " + id);
  if (!(await exists(new URL("audio.json", folder))))
    await script("capture-source-audio.mjs", [id], signal);
  const audioCoverage = JSON.parse(
    await readFile(new URL("audio.json", folder), "utf8"),
  );
  if (
    audioCoverage.source_id !== id ||
    new URL(audioCoverage.url).pathname !== `/video/${id}` ||
    Math.abs(audioCoverage.duration - frames.duration) > 0.5 ||
    audioCoverage.end < audioCoverage.duration - 0.5
  )
    throw Error("音画身份或时长不一致");
  const audio = await readFile(new URL("audio.webm", folder));
  const audioHash = hash(audio);
  let transcript;
  try {
    transcript = JSON.parse(
      await readFile(new URL("transcript.json", folder), "utf8"),
    );
  } catch {}
  if (
    !transcript ||
    transcript.source_id !== id ||
    transcript.audio_sha256 !== audioHash
  ) {
    await script("transcribe-media.py", [id], signal);
    transcript = JSON.parse(
      await readFile(new URL("transcript.json", folder), "utf8"),
    );
  }
  if (transcript.source_id !== id || transcript.audio_sha256 !== audioHash)
    throw Error("语音与原片不匹配");
  const batches = [];
  for (let start = 0; start < frames.frames.length; start += 4) {
    signal?.throwIfAborted();
    stage(`分析 ${id} 画面 ${start + 1}/${frames.frames.length}`);
    const selected = frames.frames.slice(start, start + 4);
    const images = await Promise.all(
      selected.map((f) => {
        if (!/^frame-\d+(\.\d+)?\.png$/.test(f.file))
          throw Error("无效画面路径");
        return readFile(new URL(f.file, folder)).then((b) =>
          b.toString("base64"),
        );
      }),
    );
    const end = frames.frames[start + 4]?.actual_time ?? frames.duration;
    const input = {
      source_id: id,
      frames: selected.map((f) => ({ time: f.actual_time })),
      speech: transcript.segments.filter(
        (s) => s.end >= selected[0].actual_time && s.start <= end,
      ),
      limits: "画面是定点抽样，语音是未核对ASR，没有音乐音效分析",
    };
    const key =
      "frames:" +
      hash({ input, images: images.map(hash), identity, prompt: 2 });
    let result = db.checkpoint(key);
    if (!result) {
      result = validateSchema(
        await model.json(
          "按时间顺序阅读实际画面和自动语音，不从标题推断；分清观察、方法与未知。observations.time只能用输入画面时间。音乐音效/连续动作未读。核心判断依赖声音或漏帧时标记blocking_gaps/needs_audio_review。",
          input,
          mediaSchema,
          { images, signal },
        ),
        mediaSchema,
      );
      if (
        result.observations.some(
          (o) => !input.frames.some((f) => f.time === o.time),
        )
      )
        throw Error("模型引用未读时间点");
      db.checkpoint(key, result);
    }
    batches.push(result);
  }
  stage("整理跨段叙事 " + id);
  const key = "media:" + hash({ batches, identity, prompt: 2 });
  let result = db.checkpoint(key);
  if (!result) {
    result = validateSchema(
      await model.json(
        "整合已读片段，重建对白衔接与叙事，保留未读声音与动作缺口，不把抽样说成完整阅读。任何批次blocking_gaps都必须保留，除非当前证据明确解决。",
        {
          batches,
          source_id: id,
          duration: frames.duration,
          transcript_status: transcript.status,
        },
        mediaSchema,
        { signal },
      ),
      mediaSchema,
    );
    const times = new Set(
      batches.flatMap((b) => b.observations.map((o) => o.time)),
    );
    if (result.observations.some((o) => !times.has(o.time)))
      throw Error("综合引用了未读时间");
    result.blocking_gaps = [
      ...new Set([
        ...result.blocking_gaps,
        ...batches.flatMap((b) => b.blocking_gaps),
      ]),
    ];
    result.needs_audio_review =
      result.needs_audio_review || batches.some((b) => b.needs_audio_review);
    db.checkpoint(key, result);
  }
  return {
    id: "video:" + id,
    kind: "video",
    source_id: id,
    url: `https://www.douyin.com/video/${id}`,
    title: page.title,
    author: row.author || null,
    metrics: {
      board: row.sub_type,
      window: row.date_window,
      score: row.score,
      plays: row.play_count,
      observed_at: row.collected_at,
    },
    read_at: new Date().toISOString(),
    media_hash: hash({ frames, audioHash }),
    coverage: {
      visual: "sampled_frames",
      times: frames.frames.map((f) => f.actual_time),
      speech: "automatic_transcript_unverified",
      music: "not_read",
    },
    analysis: result,
  };
}
// Visible search results supply candidates, not verified claims. No login data is exported.
export async function internetSources(game, { signal } = {}) {
  let browser, page;
  const sources = [];
  try {
    browser = await chromium.connectOverCDP(config.cdp, { timeout: 10000 });
    page = await browser.contexts()[0].newPage();
    signal?.throwIfAborted();
    await page.goto(
      "https://www.bing.com/search?q=" +
        encodeURIComponent(game + " 官方 玩法 介绍"),
      { waitUntil: "domcontentloaded", timeout: 30000 },
    );
    const links = await page
      .locator("li.b_algo h2 a")
      .evaluateAll((nodes) =>
        nodes.slice(0, 5).map((n) => ({ url: n.href, title: n.textContent })),
      );
    for (const link of links) {
      signal?.throwIfAborted();
      const u = new URL(link.url);
      if (
        u.protocol !== "https:" ||
        u.hostname === "localhost" ||
        /^\d+\./.test(u.hostname)
      )
        continue;
      try {
        await page.goto(u.href, {
          waitUntil: "domcontentloaded",
          timeout: 20000,
        });
        const text = (
          await page.locator("body").innerText({ timeout: 5000 })
        ).slice(0, 6000);
        if (text.length > 200) {
          sources.push({
            id: "web:" + hash(page.url()).slice(0, 16),
            kind: "web",
            url: page.url(),
            title: await page.title(),
            text,
            read_at: new Date().toISOString(),
            status: "source_claim_not_independently_verified",
          });
          if (sources.length >= 3) break;
        }
      } catch {}
    }
  } finally {
    await page?.close();
    await browser?.close();
  }
  return sources;
}
export function diversify(rows, limit = 5) {
  const unique = [
    ...new Map(
      rows.filter((r) => r.kind === "video").map((r) => [r.source_id, r]),
    ).values(),
  ];
  const chosen = [],
    authors = new Set();
  for (const r of unique)
    if (r.author && !authors.has(r.author)) {
      chosen.push(r);
      authors.add(r.author);
      if (chosen.length === limit) return chosen;
    }
  for (const r of unique)
    if (!chosen.some((c) => c.source_id === r.source_id)) {
      chosen.push(r);
      if (chosen.length === limit) break;
    }
  return chosen;
}
