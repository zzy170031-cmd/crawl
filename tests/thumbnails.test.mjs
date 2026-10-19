import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, readFile, symlink } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { pathToFileURL, fileURLToPath } from "node:url";
import { spawn } from "node:child_process";
import { setTimeout as delay } from "node:timers/promises";
import {
  thumbnailPath,
  readThumbnail,
  annotateThumbnails,
} from "../app/thumbnails.mjs";
import { ensureSourceThumbnail } from "../app/prepare-side-media.mjs";
import { Tasks } from "../app/tasks.mjs";
import { ContentGroups } from "../app/content-groups.mjs";
import { openStore } from "../app/store.mjs";
const jpeg = Buffer.from([255, 216, 255, 224, 0, 1, 255, 217]); // controlled HTTP fixture, not user media
const id = "12345678901";

test("缩略图只接受固定数字ID JPEG路径，拒绝文件和目录symlink逸出", async () => {
  const root = await mkdtemp(join(tmpdir(), "crawl-thumbnail-")),
    folder = join(root, "media", id);
  await mkdir(folder, { recursive: true });
  await writeFile(join(folder, "thumbnail.jpg"), jpeg);
  assert(await thumbnailPath(id, root));
  assert.deepEqual(await readThumbnail(id, root), jpeg);
  assert.equal(await thumbnailPath("../secret", root), null);
  assert.equal(await readThumbnail("12345678909", root), null);
  const outside = await mkdtemp(join(tmpdir(), "crawl-thumbnail-outside-"));
  await writeFile(join(outside, "thumbnail.jpg"), jpeg);
  const linked = join(root, "media", "12345678902");
  await mkdir(linked);
  await symlink(join(outside, "thumbnail.jpg"), join(linked, "thumbnail.jpg"));
  assert.equal(await thumbnailPath("12345678902", root), null);
  await symlink(outside, join(root, "media", "12345678903"));
  assert.equal(await thumbnailPath("12345678903", root), null);
});
test("实际原片预览提取固定时间点、保留原片，失败只记录缺口不伪造替代图", async () => {
  const root = await mkdtemp(join(tmpdir(), "crawl-thumbnail-build-")),
    folder = pathToFileURL(root + "/"),
    source = join(root, "source.mp4");
  await writeFile(source, "original-source-fixture");
  let calls = 0;
  const media = { source_id: id, source_path: source };
  const run = async (name, args) => {
    calls++;
    assert.equal(name, "ffmpeg");
    assert.equal(args[args.indexOf("-i") + 1], source);
    assert.equal(args[args.indexOf("-ss") + 1], "2");
    await writeFile(args.at(-1), jpeg);
  };
  const result = await ensureSourceThumbnail(media, {
    duration: 20,
    digest: "first",
    folder,
    run,
  });
  assert.equal(result.status, "created");
  assert.equal(result.time, 2);
  assert.equal(await readFile(source, "utf8"), "original-source-fixture");
  await ensureSourceThumbnail(media, {
    duration: 20,
    digest: "first",
    folder,
    run,
  });
  assert.equal(calls, 1);
  const failed = await ensureSourceThumbnail(media, {
    duration: 20,
    digest: "changed",
    folder,
    run: async () => {
      throw Error("controlled ffmpeg failure");
    },
  });
  assert.equal(failed.status, "failed");
  assert.equal(await readFile(source, "utf8"), "original-source-fixture");
  await assert.rejects(readFile(join(root, "thumbnail.jpg")));
  assert.equal(
    JSON.parse(await readFile(join(root, "thumbnail.json"), "utf8")).status,
    "failed",
  );
});
test("HTTP仅暴露固定缩略图，代表项与组内来源均返回各自真实预览入口", async () => {
  const folder = await mkdtemp(join(tmpdir(), "crawl-thumbnail-http-")),
    db = new Tasks(folder),
    groups = new ContentGroups(db),
    store = openStore(join(folder, "hotspots.sqlite"));
  const ids = [id, "12345678902"];
  for (const sourceId of ids) {
    await mkdir(join(folder, "media", sourceId), { recursive: true });
    await writeFile(join(folder, "media", sourceId, "thumbnail.jpg"), jpeg);
    await writeFile(
      join(folder, "media", sourceId, "source.mp4"),
      "must-not-be-served",
    );
  }
  groups.set(ids, "受控同内容来源");
  store.import({
    collection_key: JSON.stringify(["games", "testgame"]),
    collected_at: new Date().toISOString(),
    records: ids.map((source_id, i) => ({
      kind: "video",
      source_id,
      title: "fixture",
      author: "a",
      game: "testgame",
      collection: "games",
      sub_type: 0,
      date_window: 0,
      collected_at: new Date().toISOString(),
      source_endpoint: "douyin_visible_search",
      position_in_response: i + 1,
    })),
  });
  const base = "http://127.0.0.1:14321",
    child = spawn(
      process.execPath,
      [fileURLToPath(new URL("../app/server.mjs", import.meta.url))],
      {
        env: {
          ...process.env,
          PORT: "14321",
          CRAWL_DATA_DIR: folder,
          CRAWL_BROWSER_MODE: "side-browser",
          CRAWL_MODEL_URL: "http://127.0.0.1:1",
        },
        stdio: "pipe",
      },
    );
  try {
    let ready = false;
    for (let i = 0; i < 60; i++) {
      try {
        if ((await fetch(base + "/api/session")).ok) {
          ready = true;
          break;
        }
      } catch {}
      await delay(50);
    }
    assert(ready);
    const image = await fetch(base + `/api/media/${id}/thumbnail`);
    assert.equal(image.status, 200);
    assert.equal(image.headers.get("content-type"), "image/jpeg");
    assert.deepEqual(Buffer.from(await image.arrayBuffer()), jpeg);
    assert.equal(
      (await fetch(base + `/api/media/${id}/source.mp4`)).status,
      404,
    );
    assert.equal(
      (await fetch(base + "/api/media/12345678909/thumbnail")).status,
      404,
    );
    const rows = (
      await (await fetch(base + "/api/hotspots?game=testgame")).json()
    ).records;
    assert.equal(rows.length, 1);
    assert.equal(rows[0].thumbnail_url, `/api/media/${id}/thumbnail`);
    assert.deepEqual(
      rows[0].grouped_sources.map((r) => r.thumbnail_url),
      ids.map((x) => `/api/media/${x}/thumbnail`),
    );
  } finally {
    child.kill();
    await new Promise((resolve) => {
      if (child.exitCode !== null) resolve();
      else child.once("exit", resolve);
    });
    store.close();
    db.close();
  }
});

test("真实来源封面无需整段MP4，来源标记不冒充原片实读证据", async () => {
  const folder = await mkdtemp(join(tmpdir(), "crawl-cover-only-")),
    dir = join(folder, "media", id);
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, "thumbnail.jpg"), jpeg);
  const provenance = {
    kind: "source_cover",
    source_url: "https://www.douyin.com/video/" + id,
    observed_at: new Date().toISOString(),
  };
  await writeFile(join(dir, "thumbnail.json"), JSON.stringify(provenance));
  const [row] = await annotateThumbnails(
    [{ kind: "video", source_id: id }],
    folder,
  );
  assert.equal(row.thumbnail_url, `/api/media/${id}/thumbnail`);
  assert.deepEqual(row.thumbnail_provenance, provenance);
  assert.equal(row.analysis, undefined);
  assert.equal(row.media_hash, undefined);
  await assert.rejects(readFile(join(dir, "source.mp4")));
});
test('Redfox preview only annotates approved public cover hosts',async()=>{
  const {safeSourceCover}=await import('../app/thumbnails.mjs');
  const base={provider:'redfox',source_endpoint:'redfox_game_search',cover_url:'https://p3.douyinpic.com/test.jpg'};
  assert.equal(safeSourceCover(base),base.cover_url);
  for(const cover_url of ['https://douyinpic.com.evil.test/x','https://user:secret@p3.douyinpic.com/x','http://p3.douyinpic.com/x','https://p3.douyinpic.com:3000/x']) assert.equal(safeSourceCover({...base,cover_url}),null);
  assert.equal(safeSourceCover({...base,provider:'browser'}),null);
});
