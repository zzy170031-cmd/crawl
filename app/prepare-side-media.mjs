import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { readFile, writeFile, rename, unlink } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { mediaURL } from "./config.mjs";
import { hash } from "./tasks.mjs";
import { MediaUnavailableError } from "./media-unavailable.mjs";
const exec = promisify(execFile);
async function atomic(path, value) {
  await writeFile(new URL(path.href + ".tmp"), JSON.stringify(value, null, 2));
  await rename(new URL(path.href + ".tmp"), path);
}
export async function verifiedPreparedFrames(media, digest, folder) {
  try {
    const load=async name=>JSON.parse(await readFile(new URL(name,folder),"utf8"));
    const [prior,frames,page,audio]=await Promise.all([load("prepared.json"),load("frames.json"),load("page.json"),load("audio.json")]);
    if ([prior,frames,page,audio].some(value=>value.source_sha256!==digest) ||
        frames.source_id!==media.source_id || audio.source_id!==media.source_id ||
        page.url!==media.url || audio.url!==media.url || !page.title ||
        !Number.isFinite(prior.duration) || prior.duration<1 ||
        frames.duration!==prior.duration || audio.duration!==prior.duration || audio.end!==prior.duration ||
        !Array.isArray(frames.frames) || !frames.frames.length ||
        hash(await readFile(new URL("audio.webm",folder)))!==prior.audio_sha256) return null;
    for(const frame of frames.frames){
      if(!/^frame-\d+(\.\d+)?\.png$/.test(frame.file) || !Number.isFinite(frame.actual_time) ||
          frame.actual_time<0 || frame.actual_time>prior.duration ||
          hash(await readFile(new URL(frame.file,folder)))!==frame.sha256) return null;
    }
    return frames;
  } catch {return null;}
}
export async function ensureSourceThumbnail(
  media,
  { duration, digest, signal, run, folder = mediaURL(media.source_id) } = {},
) {
  const metadata = new URL("thumbnail.json", folder),
    output = new URL("thumbnail.jpg", folder);
  try {
    const old = JSON.parse(await readFile(metadata, "utf8"));
    const bytes = await readFile(output);
    if (
      old.source_sha256 === digest &&
      old.status === "created" &&
      bytes[0] === 0xff &&
      bytes[1] === 0xd8 &&
      bytes[2] === 0xff
    )
      return old;
  } catch {}
  const at = Math.min(2, duration / 2);
  try {
    signal?.throwIfAborted();
    await run("ffmpeg", [
      "-v",
      "error",
      "-y",
      "-ss",
      String(at),
      "-i",
      media.source_path,
      "-frames:v",
      "1",
      "-vf",
      "scale=960:960:force_original_aspect_ratio=decrease",
      "-q:v",
      "3",
      fileURLToPath(new URL("thumbnail.next.jpg", folder)),
    ]);
    const bytes = await readFile(new URL("thumbnail.next.jpg", folder));
    if (bytes[0] !== 0xff || bytes[1] !== 0xd8 || bytes[2] !== 0xff)
      throw Error("预览图编码无效");
    await rename(new URL("thumbnail.next.jpg", folder), output);
    const result = {
      source_id: media.source_id,
      source_sha256: digest,
      status: "created",
      kind: "video_frame",
      source_url: media.url,
      observed_at: media.observed_at || new Date().toISOString(),
      frame_time: at,
      time: at,
      method: "actual_source_frame",
      created_at: new Date().toISOString(),
    };
    await atomic(metadata, result);
    return result;
  } catch (e) {
    if (signal?.aborted) throw signal.reason;
    // Never show an old preview after the actual source changed or extraction failed.
    await unlink(output).catch(() => {});
    await unlink(new URL("thumbnail.next.jpg", folder)).catch(() => {});
    const result = {
      source_id: media.source_id,
      source_sha256: digest,
      status: "failed",
      message: "实际原片预览帧提取失败，未生成替代图",
      created_at: new Date().toISOString(),
    };
    await atomic(metadata, result);
    return result;
  }
}
export async function prepareSideMedia(media, { signal } = {}) {
  const folder = mediaURL(media.source_id),
    source = media.source_path;
  const digest = hash(await readFile(source));
  const run = (name, args) =>
    exec(name, args, {
      signal,
      timeout: 300000,
      maxBuffer: 2 * 1024 * 1024,
      windowsHide: true,
    });
  try {
    const frames = await verifiedPreparedFrames(media,digest,folder);
    if (frames) {
      return {
        thumbnail: await ensureSourceThumbnail(media, {
          duration: frames.duration,
          digest,
          signal,
          run,
          folder,
        }),
      };
    }
  } catch (e) {
    if (signal?.aborted) throw signal.reason;
  }
  const probe = JSON.parse(
    (
      await run("ffprobe", [
        "-v",
        "error",
        "-show_format",
        "-show_streams",
        "-of",
        "json",
        source,
      ])
    ).stdout,
  );
  const duration = Number(probe.format?.duration);
  if (Number.isFinite(duration) && duration > 900)
    throw new MediaUnavailableError({
      source_id: media.source_id,
      url: media.url,
      reason: `实际原片 ffprobe 时长 ${duration} 秒，超过当前支持上限 900 秒，未读取音画`,
      observed_at: new Date().toISOString(),
    });
  if (!Number.isFinite(duration) || duration < 1)
    throw Error("视频时长无效，请选择可完整处理的样本");
  if (!probe.streams?.some((s) => s.codec_type === "video"))
    throw Error("实际原片缺少视频流");
  const thumbnail = await ensureSourceThumbnail(media, {
    duration,
    digest,
    signal,
    run,
    folder,
  });
  if (!probe.streams.some((s) => s.codec_type === "audio"))
    throw Error("实际原片缺少音轨，不能标记已核验语音");
  const interval = Math.max(3, duration / 60),
    times = [];
  for (let t = 0; t < duration - 0.3; t += interval)
    times.push(Number(t.toFixed(1)));
  times.push(Number(Math.max(0, duration - 0.3).toFixed(1)));
  const frames = [];
  for (const t of [...new Set(times)]) {
    signal?.throwIfAborted();
    const filename = `frame-${t.toFixed(1)}.png`;
    await run("ffmpeg", [
      "-v",
      "error",
      "-y",
      // Input seeking decodes from the prior keyframe, not the start of
      // the entire video for every sample; accurate seeking stays enabled.
      "-ss",
      String(t),
      "-i",
      source,
      "-frames:v",
      "1",
      "-vf",
      "scale=960:960:force_original_aspect_ratio=decrease",
      fileURLToPath(new URL(filename, folder)),
    ]);
    const frameDigest = hash(await readFile(new URL(filename, folder)));
    frames.push({ requested_time: t, actual_time: t, file: filename, sha256:frameDigest });
  }
  await run("ffmpeg", [
    "-v",
    "error",
    "-y",
    "-i",
    source,
    "-vn",
    "-c:a",
    "libopus",
    "-ac",
    "1",
    "-ar",
    "48000",
    fileURLToPath(new URL("audio.webm", folder)),
  ]);
  await atomic(new URL("page.json", folder), {
    url: media.url,
    title: media.title,
    observed_at: media.observed_at,
    source_sha256: digest,
    coverage: media.provider === "redfox"
      ? "实际下载原片；来源元数据来自已保存红狐查询与解析回执"
      : "实际下载原片；页面元数据来自右侧浏览器观察",
  });
  await atomic(new URL("frames.json", folder), {
    source_id: media.source_id,
    duration,
    frames,
    source_sha256: digest,
    coverage: "定点抽帧，非逐帧完整阅读",
  });
  await atomic(new URL("audio.json", folder), {
    source_id: media.source_id,
    url: media.url,
    duration,
    start: 0,
    end: duration,
    source_sha256: digest,
    method: "full-source-audio-extraction",
  });
  await atomic(new URL("prepared.json", folder), {
    source_sha256: digest,
    duration,
    audio_sha256: hash(await readFile(new URL("audio.webm",folder))),
    prepared_at: new Date().toISOString(),
  });
  return { thumbnail };
}
