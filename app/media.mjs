import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { readFile, writeFile, access } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright-core";
import { config, mediaURL, dataDir, root } from "./config.mjs";
import { hash } from "./tasks.mjs";
import { mediaSchema, validateSchema } from "./contracts.mjs";
import { prepareSideMedia } from "./prepare-side-media.mjs";
import { MediaUnavailableError } from "./media-unavailable.mjs";
import { redfoxAssets } from "./redfox-assets.mjs";
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
  {
    db,
    model,
    signal,
    stage,
    identity,
    reviewRevision,
    bridge,
    taskId,
    browserMode = config.browserMode,
  },
) {
  const id = row.source_id;
  if (row.kind !== "video" || !/^\d{10,25}$/.test(id))
    throw Error("需要具体视频作品，不能将话题或搜索页当原片");
  const folder = mediaURL(id);
  const framesFile = new URL("frames.json", folder),
    pageFile = new URL("page.json", folder);
  let thumbnail = null;
  if (row.provider === "redfox") {
    ({ thumbnail } = await prepareRedfoxMedia(row, { signal, stage }));
  } else if (browserMode === "side-browser") {
    stage("等待助手读取右侧原片 " + id);
    const request = bridge.request(
      "media",
      { source_id: id, url: `https://www.douyin.com/video/${id}` },
      { taskId },
    );
    const media = await bridge.wait(request, { signal });
    if (media.status === "unavailable") {
      if (media.source_id !== id || new URL(media.url).origin !== "https://www.douyin.com" ||
          new URL(media.url).pathname !== `/video/${id}`)
        throw Error("不可读媒体身份不匹配");
      throw new MediaUnavailableError(media);
    }
    stage("从实际原片提取音画 " + id);
    ({ thumbnail } = await prepareSideMedia(media, { signal }));
  }
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
  const mediaHash = hash({ frames, audioHash });
  let subtitleReview = null,
    ocrReadings = [],
    reviewedSegments = transcript.segments;
  if (browserMode === "side-browser") {
    const ocrSchema = {
      type: "object",
      additionalProperties: false,
      required: ["text"],
      properties: {
        text: { type: "string" },
      },
    };
    for (let start = 0; start < frames.frames.length; start += 1) {
      signal?.throwIfAborted();
      stage(`独立读取 ${id} 画面字幕 ${start + 1}/${frames.frames.length}`);
      const selected = frames.frames.slice(start, start + 1);
      const images = await Promise.all(
        selected.map((f) => {
          if (!/^frame-\d+(\.\d+)?\.png$/.test(f.file))
            throw Error("无效画面路径");
          return readFile(new URL(f.file, folder)).then((b) =>
            b.toString("base64"),
          );
        }),
      );
      const times = selected.map((f) => f.actual_time),
        key =
          "ocr:" +
          hash({ times, images: images.map(hash), identity, prompt: 2 });
      let ocr = db.checkpoint(key);
      if (!ocr) {
        const frameText = validateSchema(
          await model.json(
            "逐字读取这张图中能看清的文字，不猜测。不做分析。全部文字按行放在一个text字符串中；看不清用[不清]，没有文字用空字符串。",
            { task: "提取单张画面的可见文字" },
            ocrSchema,
            { images, signal, contextLength: 8192, maxTokens: 2048, prefillJson: true },
          ),
          ocrSchema,
        );
        // One image per request: the time comes from the local frame manifest,
        // never from generated OCR text.
        ocr = { readings: [{ time: times[0], text: frameText.text }] };
        db.checkpoint(key, ocr);
      }
      ocrReadings.push(...ocr.readings);
    }
    await writeFile(
      new URL("ocr.json", folder),
      JSON.stringify(
        {
          source_id: id,
          media_hash: mediaHash,
          readings: ocrReadings,
          status: "independent_visual_ocr_machine_read",
        },
        null,
        2,
      ),
    );
    stage("等待助手核对原始转写与画面字幕 " + id);
    const request = bridge.request(
      "transcript-review",
      {
        source_id: id,
        media_hash: mediaHash,
        review_revision: reviewRevision || "initial",
        segments: transcript.segments,
        ocr_readings: ocrReadings,
        frames: frames.frames.map((f) => ({
          time: f.actual_time,
          file: f.file,
        })),
      },
      { taskId },
    );
    subtitleReview = await bridge.wait(request, { signal });
    await writeFile(
      new URL("term-review.json", folder),
      JSON.stringify(subtitleReview, null, 2),
    );
    reviewedSegments = transcript.segments.map((s, i) => ({
      ...s,
      text:
        subtitleReview.corrections.find((c) => c.segment_index === i)
          ?.corrected_text || s.text,
    }));
  }
  const batches = [];
  for (let start = 0; start < frames.frames.length; start += 1) {
    signal?.throwIfAborted();
    stage(`分析 ${id} 画面 ${start + 1}/${frames.frames.length}`);
    const selected = frames.frames.slice(start, start + 1);
    const images = await Promise.all(
      selected.map((f) => {
        if (!/^frame-\d+(\.\d+)?\.png$/.test(f.file))
          throw Error("无效画面路径");
        return readFile(new URL(f.file, folder)).then((b) =>
          b.toString("base64"),
        );
      }),
    );
    const end = frames.frames[start + 1]?.actual_time ?? frames.duration;
    const input = {
      source_id: id,
      frames: selected.map((f) => ({ time: f.actual_time })),
      speech: reviewedSegments.filter(
        (s) => s.end >= selected[0].actual_time && s.start <= end,
      ),
      independent_subtitles: ocrReadings.filter(
        (o) => selected.some((f) => f.actual_time === o.time),
      ),
      subtitle_review_status: subtitleReview?.status || "not_reviewed",
      subtitle_review_revision: subtitleReview
        ? {
            reviewed_at: subtitleReview.reviewed_at,
            corrections: subtitleReview.corrections,
            uncertainties: subtitleReview.uncertainties,
          }
        : null,
      limits:
        "画面是定点抽样；转写复核仅限有同时间字幕依据的引用点，没有音乐音效分析",
    };
    const frameSchema = structuredClone(mediaSchema);
    frameSchema.properties.observations.items.properties.time.enum = input.frames.map((f) => f.time);
    const key =
      "frames:" +
      hash({ input, images: images.map(hash), identity, prompt: 4 });
    let result = db.checkpoint(key);
    if (!result) {
      result = validateSchema(
        await model.json(
          "阅读当前实际画面与同段转写，是否已复核以subtitle_review_status为准。提取原片的可见内容、说法及表达方法，不从标题推断。observations.time只能用输入画面时间。你评估的是原片内容是否可读，不是验证所有游戏规则。官方真实性、版本日期、缺少实测对照等属于uncertainties，作者爆料必须标明来源主张，不能升格为游戏事实。blocking_gaps仅填写使本段核心内容无法辨认的具体证据缺口，如关键字幕不可读、关键口播缺失、结论必须依赖未读的连续动作。音乐音效未分析应保留在uncertainties；只有理解核心内容必须依赖这些声音时才needs_audio_review=true。不要为无关背景细节或原片未谈的资料制造阻塞。",
          input,
          frameSchema,
          { images, signal, contextLength: 8192, maxTokens: 4096, prefillJson: true },
        ),
        frameSchema,
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
  const synthesisInput = {
    batches,
    source_id: id,
    duration: frames.duration,
    transcript_status: subtitleReview?.status || transcript.status,
    raw_transcript_status: transcript.status,
    subtitle_review_status: subtitleReview?.status || "not_reviewed",
  };
  const synthesisSchema = structuredClone(mediaSchema);
  synthesisSchema.properties.observations.items.properties.time.enum = [...new Set(batches.flatMap((b) => b.observations.map((o) => o.time)))];
  const key = "media:" + hash({ input: synthesisInput, identity, prompt: 4 });
  let result = db.checkpoint(key);
  if (!result) {
    result = validateSchema(
      await model.json(
        "整合已读片段，重建对白衔接与叙事，保留未读声音与动作缺口，不把抽样说成完整阅读。任何批次blocking_gaps都必须保留，除非当前证据明确解决。",
        synthesisInput,
        synthesisSchema,
        { signal, contextLength: 16384, maxTokens: 8192, prefillJson: true },
      ),
      synthesisSchema,
    );
    const times = new Set(
      batches.flatMap((b) => b.observations.map((o) => o.time)),
    );
    if (result.observations.some((o) => !times.has(o.time)))
      throw Error("综合引用了未读时间");
    result.uncertainties = [...new Set([...result.uncertainties, ...batches.flatMap((b) => b.uncertainties)])];
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
  if (subtitleReview?.status === "needs_review") {
    result = {
      ...result,
      needs_audio_review: true,
      blocking_gaps: [...result.blocking_gaps, ...subtitleReview.uncertainties],
    };
  }
  return {
    id: "video:" + id,
    kind: "video",
    source_id: id,
    content_group_id: row.content_group_id || `video:${id}`,
    content_group_basis: row.content_group_basis || null,
    thumbnail_url:
      thumbnail?.status === "created" ? `/api/media/${id}/thumbnail` : null,
    thumbnail_status: thumbnail?.status || "not_generated",
    thumbnail_gap: thumbnail?.status === "failed" ? thumbnail.message : null,
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
    media_hash: mediaHash,
    transcript: {
      status: transcript.status,
      raw_segments: transcript.segments,
      reviewed_segments: reviewedSegments,
    },
    subtitle_review: subtitleReview
      ? { ...subtitleReview, ocr_readings: ocrReadings }
      : null,
    coverage: {
      visual: "sampled_frames",
      times: frames.frames.map((f) => f.actual_time),
      speech:
        subtitleReview && subtitleReview.status !== "needs_review"
          ? "automatic_transcript_with_subtitle_point_review"
          : "automatic_transcript_unverified",
      music: "not_read",
    },
    analysis: result,
  };
}
// Visible search results supply candidates, not verified claims. No login data is exported.
export async function internetSources(
  game,
  { signal, bridge, taskId, browserMode = config.browserMode } = {},
) {
  if (browserMode === "side-browser") {
    const result = await bridge.wait(
      bridge.request("web", { game }, { taskId }),
      { signal },
    );
    return result.sources;
  }
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
  const seen = new Set(),
    unique = [];
  for (const row of rows.filter((r) => r.kind === "video")) {
    const key = row.content_group_id || row.source_id;
    if (seen.has(key)) continue;
    seen.add(key);
    unique.push(row);
  }
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

// Cross-task evidence reuse is permitted only when actual media, transcript,
// review artifacts and model identity still match. Preview covers do not count.
export async function mediaFingerprint(
  row,
  { identity, browserMode = config.browserMode } = {},
) {
  if (row.kind !== "video" || !/^\d{10,25}$/.test(row.source_id)) return null;
  const folder = mediaURL(row.source_id);
  try {
    const asset = row.provider === "redfox" ? await redfoxAssets.read(row) : null;
    const frames = JSON.parse(
      await readFile(new URL("frames.json", folder), "utf8"),
    );
    if (!Array.isArray(frames.frames) || !frames.frames.length) return null;
    if (asset) {
      const page=JSON.parse(await readFile(new URL("page.json",folder),"utf8"));
      const audio=JSON.parse(await readFile(new URL("audio.json",folder),"utf8"));
      if ([frames,page,audio].some(item=>item.source_sha256!==asset.source_sha256) ||
          frames.source_id!==row.source_id || audio.source_id!==row.source_id || page.url!==row.source_url)
        return null;
    }
    const files = [
      "frames.json",
      "page.json",
      "audio.json",
      "audio.webm",
      "transcript.json",
    ];
    if (asset) files.push("redfox-source.mp4");
    if (browserMode === "side-browser") {
      if (!asset) files.push("source.mp4");
      files.push("ocr.json", "term-review.json");
    }
    for (const f of frames.frames) {
      if (!/^frame-\d+(\.\d+)?\.png$/.test(f.file)) return null;
      files.push(f.file);
    }
    const content = [];
    for (const file of files)
      content.push([file, hash(await readFile(new URL(file, folder)))]);
    return hash({
      source_id: row.source_id,
      identity,
      ...(asset ? {source_provider:"redfox",source_sha256:asset.source_sha256} : {}),
      pipeline_revision: 1,
      browserMode,
      content,
    });
  } catch {
    return null;
  }
}

// Source preparation is independently verifiable without invoking ASR, models,
// subtitle review or document writing.
export async function prepareRedfoxMedia(row, {signal,stage=()=>{},assets=redfoxAssets}={}) {
  stage('读取已入库的红狐原片 '+row.source_id);
  const media=await assets.read(row);
  return prepareSideMedia(media,{signal});
}
