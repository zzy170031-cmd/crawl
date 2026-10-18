import { spawn } from "node:child_process";
import { mkdirSync, existsSync } from "node:fs";
import { join } from "node:path";
import { config, dataDir } from "../app/config.mjs";
try {
  const r = await fetch(config.cdp + "/json/version", {
    signal: AbortSignal.timeout(1500),
  });
  if (r.ok) {
    console.log("专用浏览器已运行 " + config.cdp);
    process.exit(0);
  }
} catch {}
const candidates =
  process.platform === "darwin"
    ? ["/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"]
    : process.platform === "win32"
      ? [
          join(
            process.env.PROGRAMFILES || "C:/Program Files",
            "Google/Chrome/Application/chrome.exe",
          ),
          join(
            process.env.LOCALAPPDATA || "",
            "Google/Chrome/Application/chrome.exe",
          ),
        ]
      : ["/usr/bin/google-chrome", "/usr/bin/chromium"];
const executable = process.env.CRAWL_CHROME_PATH || candidates.find(existsSync);
if (!executable) throw Error("未找到Chrome，请配置CRAWL_CHROME_PATH");
const profile = join(dataDir, "browser-profile");
mkdirSync(profile, { recursive: true });
const child = spawn(
  executable,
  [
    `--remote-debugging-port=${new URL(config.cdp).port}`,
    `--user-data-dir=${profile}`,
    "--no-first-run",
    "https://douhot.douyin.com/square/hotspot?active_tab=hotspot_all",
  ],
  { detached: true, stdio: "ignore", windowsHide: true },
);
child.on("error", (e) => {
  console.error(e.message);
  process.exitCode = 1;
});
child.unref();
console.log("已启动独立浏览器，请在其中登录热点宝和抖音。");
