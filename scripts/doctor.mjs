import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { platform, arch, totalmem } from "node:os";
import { mkdir, writeFile, readFile } from "node:fs/promises";
import { join } from "node:path";
import { config, dataDir, root } from "../app/config.mjs";
import { Model } from "../app/model.mjs";
import { object, strings, validateSchema } from "../app/contracts.mjs";
const exec = promisify(execFile);
const report = {
  at: new Date().toISOString(),
  platform: platform(),
  arch: arch(),
  memory_gib: Math.round(totalmem() / 1024 ** 3),
  node: process.version,
  checks: {},
  limits: [
    "模型存在不等于真实媒体能力通过",
    "此诊断不代表腾讯端到端或M5验收通过",
  ],
};
async function check(name, fn) {
  try {
    report.checks[name] = { status: "ok", result: await fn() };
  } catch (e) {
    report.checks[name] = {
      status: "failed",
      reason: String(e.message).slice(0, 500),
    };
  }
}
await check("browser", async () => {
  const r = await fetch(config.cdp + "/json/version", {
    signal: AbortSignal.timeout(3000),
  });
  if (!r.ok) throw Error("浏览器不可用");
  return (await r.json()).Browser;
});
const model = new Model();
await check("model", () => model.identity());
await check("asr_installed", async () => {
  const code =
    "from faster_whisper import WhisperModel; import os; m=WhisperModel(os.environ.get('CRAWL_WHISPER_MODEL','small'),device='cpu',compute_type='int8',download_root=os.environ.get('CRAWL_WHISPER_CACHE') or None,local_files_only=True); print('cached model loaded; not audio acceptance')";
  const r = await exec(config.python, ["-c", code], {
    timeout: 60000,
    windowsHide: true,
    env: { ...process.env, HF_HUB_OFFLINE: "1" },
  });
  return r.stdout.trim();
});
if (process.argv.includes("--probe"))
  await check("real_image_probe", async () => {
    const image = await readFile(join(root, "tests/fixtures/two-colors.png"));
    const schema = object({ colors: strings });
    const start = Date.now();
    const result = validateSchema(
      await model.json(
        "识别图片从左到右的两块纯色，colors使用英文小写颜色名，不输出其他颜色。",
        {},
        schema,
        { images: [image.toString("base64")] },
      ),
      schema,
    );
    if (result.colors.join(",") !== "red,blue")
      throw Error("图像探针答案不正确");
    return {
      result,
      elapsed_ms: Date.now() - start,
      scope: "仅双色图像，不代表视频理解",
    };
  });
await mkdir(dataDir, { recursive: true });
await writeFile(join(dataDir, "doctor.json"), JSON.stringify(report, null, 2));
console.log(JSON.stringify(report, null, 2));
if (Object.values(report.checks).some((c) => c.status === "failed"))
  process.exitCode = 1;
