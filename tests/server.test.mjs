import { request } from "node:http";
import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
test("干净空库启动、一级行业目录与写请求来源保护", async () => {
  const folder = await mkdtemp(join(tmpdir(), "crawl-server-"));
  const port = 14319;
  const child = spawn(
    process.execPath,
    [fileURLToPath(new URL("../app/server.mjs", import.meta.url))],
    {
      env: { ...process.env, PORT: String(port), CRAWL_DATA_DIR: folder },
      stdio: "pipe",
      windowsHide: true,
    },
  );
  let stderr = "";
  child.stderr.on("data", (b) => (stderr += b));
  try {
    let ready = false;
    for (let i = 0; i < 60; i++) {
      try {
        const r = await fetch(`http://127.0.0.1:${port}/api/session`);
        if (r.ok) {
          ready = true;
          break;
        }
      } catch {}
      await delay(100);
    }
    assert(ready, stderr);
    const base = `http://127.0.0.1:${port}`;
    const categories = await (await fetch(base + "/api/categories")).json();
    assert.equal(categories.categories.length, 38);
    assert(categories.categories.every((c) => !c.children));
    assert.deepEqual(
      (await (await fetch(base + "/api/hotspots")).json()).records,
      [],
    );
    const bad = await fetch(base + "/api/settings", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "{}",
    });
    assert.equal(bad.status, 403);
    const hostStatus = await new Promise((resolve, reject) => {
      const r = request(
        base + "/api/session",
        { headers: { Host: "untrusted.example" } },
        (res) => {
          res.resume();
          resolve(res.statusCode);
        },
      );
      r.on("error", reject);
      r.end();
    });
    assert.equal(hostStatus, 403);
    const home = await fetch(base);
    assert.equal(home.status, 200);
    assert((await home.text()).includes("热点游戏创作台"));
    const { token } = await (await fetch(base + "/api/session")).json();
    const subscribed = await fetch(base + "/api/subscriptions", {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-crawl-token": token },
      body: JSON.stringify({
        board: 1001,
        hours: 24,
        category: "all",
        enabled: false,
      }),
    });
    assert.equal(subscribed.status, 200);
    const subs = await (await fetch(base + "/api/subscriptions")).json();
    assert.equal(subs[0].enabled, false);
  } finally {
    child.kill();
    await new Promise((resolve) => {
      if (child.exitCode !== null) resolve();
      else child.once("exit", resolve);
    });
  }
});
