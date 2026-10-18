import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
const temp = await mkdtemp(join(tmpdir(), "crawl-media-"));
process.env.CRAWL_DATA_DIR = temp;
const { Tasks, hash } = await import("../app/tasks.mjs");
const { inspectMedia } = await import("../app/media.mjs");
test("多批媒体中断后复用成功检查点，拒绝音画不一致", async () => {
  const id = "12345678901",
    folder = join(temp, "media", id);
  await mkdir(folder, { recursive: true });
  const audio = Buffer.from("synthetic audio fixture");
  const page = { url: "https://www.douyin.com/video/" + id, title: "测试原片" };
  const frames = Array.from({ length: 5 }, (_, i) => ({
    file: `frame-${i}.png`,
    actual_time: i,
  }));
  await Promise.all([
    writeFile(join(folder, "page.json"), JSON.stringify(page)),
    writeFile(
      join(folder, "frames.json"),
      JSON.stringify({ duration: 5, frames }),
    ),
    writeFile(join(folder, "audio.webm"), audio),
    writeFile(
      join(folder, "audio.json"),
      JSON.stringify({ source_id: id, url: page.url, duration: 5, end: 5 }),
    ),
    writeFile(
      join(folder, "transcript.json"),
      JSON.stringify({
        source_id: id,
        audio_sha256: hash(audio),
        segments: [],
        status: "no_speech_recognized",
      }),
    ),
    ...frames.map((f) =>
      writeFile(join(folder, f.file), "synthetic image fixture"),
    ),
  ]);
  const db = new Tasks(temp);
  let calls = 0,
    fail = true;
  const model = {
    json: async (system, input) => {
      calls++;
      if (input.frames?.[0]?.time === 4 && fail) {
        fail = false;
        throw Error("simulated timeout");
      }
      return {
        summary: "测试",
        observations: input.frames
          ? input.frames.map((f) => ({ time: f.time, text: "fixture" }))
          : input.batches.flatMap((b) => b.observations),
        speech_notes: "ASR未识别",
        creative_methods: [],
        uncertainties: ["音效未读"],
        blocking_gaps: [],
        needs_audio_review: false,
      };
    },
  };
  const ctx = {
    db,
    model,
    identity: { digest: "test" },
    stage: () => {},
    signal: new AbortController().signal,
  };
  await assert.rejects(
    inspectMedia({ kind: "video", source_id: id }, ctx),
    /timeout/,
  );
  const before = calls;
  const result = await inspectMedia({ kind: "video", source_id: id }, ctx);
  assert.equal(calls - before, 2, "仅重试第二批并综合，第一批不重算");
  assert.equal(result.coverage.music, "not_read");
  await writeFile(
    join(folder, "audio.json"),
    JSON.stringify({ source_id: id, url: page.url, duration: 30, end: 30 }),
  );
  await assert.rejects(
    inspectMedia({ kind: "video", source_id: id }, ctx),
    /音画身份/,
  );
  db.close();
});
