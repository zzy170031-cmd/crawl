import { config, mediaURL } from "./config.mjs";
import { createRequire } from "node:module";
import { mkdir, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
const require = createRequire(import.meta.url);
const { chromium } = require("playwright-core");
const id = process.argv[2];
if (!/^\d{10,25}$/.test(id || "")) throw Error("需要具体作品ID");
const browser = await chromium.connectOverCDP(config.cdp, { timeout: 10000 });
let page;
try {
  page = await browser.contexts()[0].newPage();
  await page.goto(`https://www.douyin.com/video/${id}`, {
    waitUntil: "domcontentloaded",
    timeout: 30000,
  });
  await page.waitForTimeout(5000);
  await page
    .waitForFunction(
      () =>
        document.title.includes(" - 抖音") &&
        document.querySelector("video")?.duration > 5,
      {},
      { timeout: 20000 },
    )
    .catch(() => {});
  if (process.argv.includes("--frames")) {
    if (
      await page
        .getByText("登录后免费畅享高清视频", { exact: true })
        .isVisible()
    )
      throw Error("需要在专用浏览器登录后重试");
    const folder = mediaURL(id);
    await mkdir(folder, { recursive: true });
    const video = page.locator("video").first();
    const duration = await video.evaluate((v) => v.duration);
    if (!Number.isFinite(duration) || duration < 5)
      throw Error("目标视频尚未确认加载");
    const interval = Math.max(3, duration / 60);
    const times = Array.from(
      { length: Math.ceil(duration / interval) },
      (_, i) => i * interval,
    );
    times.push(Math.max(0, duration - 0.3));
    const frames = [];
    for (const t of [...new Set(times)].filter((t) => t < duration)) {
      await video.evaluate(
        (v, t) =>
          new Promise((resolve, reject) => {
            v.pause();
            const timeout = setTimeout(() => reject(Error("定位超时")), 7000);
            const done = () => {
              clearTimeout(timeout);
              resolve();
            };
            if (Math.abs(v.currentTime - t) < 0.05) return done();
            v.addEventListener("seeked", done, { once: true });
            v.currentTime = t;
          }),
        t,
      );
      await page.waitForTimeout(150);
      const filename = `frame-${t.toFixed(1)}.png`;
      await video.screenshot({
        path: fileURLToPath(new URL(filename, folder)),
      });
      frames.push({
        requested_time: t,
        actual_time: await video.evaluate((v) => v.currentTime),
        file: filename,
      });
    }
    await writeFile(
      new URL("frames.json", folder),
      JSON.stringify(
        {
          duration,
          frames,
          coverage: "定点画面抽样；声音未读取；不是完整视频阅读",
        },
        null,
        2,
      ),
    );
  }
  const evidence = await page.evaluate(() => ({
    url: location.href,
    title: document.title,
    text: document.body.innerText.slice(0, 18000),
    videos: [...document.querySelectorAll("video")].map((v) => ({
      duration: Number.isFinite(v.duration) ? v.duration : null,
      currentTime: v.currentTime,
      width: v.videoWidth,
      height: v.videoHeight,
      readyState: v.readyState,
      paused: v.paused,
      error: v.error?.message || null,
    })),
  }));
  evidence.observed_at = new Date().toISOString();
  evidence.coverage = "页面与播放能力检查；未完成视频阅读";
  const folder = mediaURL(id);
  await mkdir(folder, { recursive: true });
  await writeFile(
    new URL("page.json", folder),
    JSON.stringify(evidence, null, 2),
  );
  await page.screenshot({ path: fileURLToPath(new URL("page.png", folder)) });
  console.log(JSON.stringify(evidence));
} catch (e) {
  console.error(String(e.message).split("\n")[0]);
  process.exitCode = 1;
} finally {
  await page?.close();
  await browser.close();
}
