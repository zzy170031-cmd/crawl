import { config, mediaURL } from "./config.mjs";
import { createRequire } from "node:module";
import { mkdir, writeFile } from "node:fs/promises";
const require = createRequire(import.meta.url);
const { chromium } = require("playwright-core");
const id = process.argv[2];
if (!/^\d{10,25}$/.test(id || "")) throw Error("需要具体作品ID");
const browser = await chromium.connectOverCDP(config.cdp, { timeout: 10000 });
let page;
let deadline;
try {
  page = await browser.contexts()[0].newPage();
  deadline = setTimeout(() => page.close().catch(() => {}), 240000);
  await page.goto(`https://www.douyin.com/video/${id}`, {
    waitUntil: "domcontentloaded",
    timeout: 30000,
  });
  await page.waitForFunction(
    () =>
      document.title.includes(" - 抖音") &&
      document.querySelector("video")?.duration > 5,
    {},
    { timeout: 30000 },
  );
  console.log("Confirmed sample; reading audio track");
  const result = await page
    .locator("video")
    .first()
    .evaluate(async (v) => {
      if (!Number.isFinite(v.duration) || v.duration > 180)
        throw Error("验证仅处理已加载的180秒内样片");
      v.pause();
      v.loop = false;
      v.playbackRate = 1;
      await new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(Error("回到片头超时")), 7000);
        v.addEventListener(
          "seeked",
          () => {
            clearTimeout(timer);
            resolve();
          },
          { once: true },
        );
        v.currentTime = 0;
        if (v.currentTime < 0.05) {
          clearTimeout(timer);
          resolve();
        }
      });
      const stream = v.captureStream?.();
      if (!stream) throw Error("播放器不支持音轨读取");
      const tracks = stream.getAudioTracks();
      if (!tracks.length) throw Error("播放器未提供可读取音轨");
      const recorder = new MediaRecorder(new MediaStream(tracks), {
        mimeType: "audio/webm;codecs=opus",
      });
      const chunks = [];
      recorder.ondataavailable = (e) => {
        if (e.data.size) chunks.push(e.data);
      };
      const start = v.currentTime;
      const duration = v.duration;
      let end = start;
      const watch = setInterval(() => {
        end = Math.max(end, v.currentTime);
      }, 100);
      return await new Promise((resolve, reject) => {
        const timer = setTimeout(
          () => {
            recorder.stop();
            reject(Error("音轨读取超时，未保存不完整录音"));
          },
          (duration + 25) * 1000,
        );
        recorder.onerror = () => {
          clearTimeout(timer);
          reject(Error("音轨录制失败"));
        };
        recorder.onstop = async () => {
          clearTimeout(timer);
          clearInterval(watch);
          const bytes = new Uint8Array(await new Blob(chunks).arrayBuffer());
          let binary = "";
          for (let i = 0; i < bytes.length; i += 8192)
            binary += String.fromCharCode(...bytes.subarray(i, i + 8192));
          resolve({
            base64: btoa(binary),
            start,
            end,
            duration,
            mime: "audio/webm;codecs=opus",
          });
        };
        v.addEventListener("ended", () => recorder.stop(), { once: true });
        recorder.start(1000);
        v.play().catch((e) => {
          clearTimeout(timer);
          recorder.stop();
          reject(Error("播放失败"));
        });
      });
    });
  const { base64, ...coverage } = result;
  if (coverage.end < coverage.duration - 0.5)
    throw Error(`音轨结束位置不完整：${JSON.stringify(coverage)}`);
  const folder = mediaURL(id);
  await mkdir(folder, { recursive: true });
  await writeFile(new URL("audio.webm", folder), Buffer.from(base64, "base64"));
  await writeFile(
    new URL("audio.json", folder),
    JSON.stringify(
      {
        source_id: id,
        url: page.url(),
        title: await page.title(),
        captured_at: new Date().toISOString(),
        ...coverage,
        status: "captured_not_transcribed",
      },
      null,
      2,
    ),
  );
  console.log(
    JSON.stringify({
      source_id: id,
      ...coverage,
      status: "captured_not_transcribed",
    }),
  );
} finally {
  clearTimeout(deadline);
  await page?.close();
  await browser.close();
}
