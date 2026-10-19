import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
const temp = await mkdtemp(join(tmpdir(), "crawl-media-"));
process.env.CRAWL_DATA_DIR = temp;
const { Tasks, hash } = await import("../app/tasks.mjs");
const { inspectMedia, mediaFingerprint } = await import("../app/media.mjs");
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
    json: async (system, input, schema) => {
      calls++;
      assert.deepEqual(schema.properties.observations.items.properties.time.enum,
        input.frames ? input.frames.map((f) => f.time) : [0, 1, 2, 3, 4]);
      if (input.batches) {
        assert.equal(input.transcript_status, "no_speech_recognized");
        assert.equal(input.raw_transcript_status, "no_speech_recognized");
        assert.equal(input.subtitle_review_status, "not_reviewed");
      }
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
        uncertainties: input.frames ? ["音效未读", "单帧证据限制"] : [],
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
  assert(result.analysis.uncertainties.includes("单帧证据限制"), "综合不能丢失片段中的来源限制");
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

test("跨任务缓存指纹覆盖实际原片、抽帧、转写、术语复核和模型身份", async () => {
  const id = "12345678902",
    folder = join(temp, "media", id);
  await mkdir(folder, { recursive: true });
  const payloads = {
    "frames.json": JSON.stringify({
      frames: [{ file: "frame-0.png", actual_time: 0 }],
    }),
    "page.json": "{}",
    "audio.json": "{}",
    "audio.webm": "audio",
    "transcript.json": "raw ASR",
    "source.mp4": "actual source fixture",
    "ocr.json": "OCR",
    "term-review.json": "reviewed",
    "frame-0.png": "frame pixels fixture",
  };
  for (const [file, text] of Object.entries(payloads))
    await writeFile(join(folder, file), text);
  const row = { kind: "video", source_id: id },
    options = {
      identity: { name: "model", digest: "v1" },
      browserMode: "side-browser",
    },
    base = await mediaFingerprint(row, options);
  assert(base);
  assert.equal(await mediaFingerprint(row, options), base);
  for (const file of [
    "source.mp4",
    "frame-0.png",
    "transcript.json",
    "term-review.json",
  ]) {
    await writeFile(join(folder, file), "changed " + payloads[file]);
    assert.notEqual(await mediaFingerprint(row, options), base);
    await writeFile(join(folder, file), payloads[file]);
  }
  assert.notEqual(
    await mediaFingerprint(row, {
      ...options,
      identity: { name: "model", digest: "v2" },
    }),
    base,
  );
});

test('Redfox fingerprint follows verified asset rather than stale browser source.mp4',async()=>{
 const id='12345678903',folder=join(temp,'media',id),raw='redfox file fixture',digest=hash(raw);
 const row={provider:'redfox',kind:'video',source_id:id,source_url:`https://www.douyin.com/video/${id}`,collection_request_id:'one',duration_ms:10000};
 await mkdir(folder,{recursive:true});
 const files={
  'redfox-source.mp4':raw,'source.mp4':'old browser file',
  'redfox-asset.json':JSON.stringify({provider:'redfox',source_id:id,url:row.source_url,source_sha256:digest,bytes:Buffer.byteLength(raw),duration:10,status:'av_readable'}),
  'frames.json':JSON.stringify({source_id:id,source_sha256:digest,frames:[{file:'frame-0.png',actual_time:0}]}),
  'page.json':JSON.stringify({url:row.source_url,source_sha256:digest}),
  'audio.json':JSON.stringify({source_id:id,source_sha256:digest}),
  'audio.webm':'audio','transcript.json':'raw ASR','ocr.json':'OCR','term-review.json':'reviewed','frame-0.png':'pixels',
 };
 for(const [name,value] of Object.entries(files))await writeFile(join(folder,name),value);
 const options={browserMode:'side-browser',identity:{name:'test'}},base=await mediaFingerprint(row,options);
 assert(base);assert.equal(await mediaFingerprint({...row,collection_request_id:'two'},options),base);
 await writeFile(join(folder,'source.mp4'),'different old browser file');assert.equal(await mediaFingerprint(row,options),base);
 await writeFile(join(folder,'redfox-source.mp4'),'corrupt');assert.equal(await mediaFingerprint(row,options),null);
 await writeFile(join(folder,'redfox-source.mp4'),raw);
 await writeFile(join(folder,'page.json'),JSON.stringify({url:row.source_url,source_sha256:'old'}));assert.equal(await mediaFingerprint(row,options),null);
 await writeFile(join(folder,'page.json'),files['page.json']);
 await writeFile(join(folder,'redfox-asset.json'),'{}');assert.equal(await mediaFingerprint(row,options),null);
});
