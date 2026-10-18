import { readFile } from "node:fs/promises";
import { config } from "../app/config.mjs";
const base = `http://127.0.0.1:${config.port}`;
const [command, arg] = process.argv.slice(2);
const token = (await (await fetch(base + "/api/session")).json()).token;
async function call(path, data) {
  const response = await fetch(
    base + path,
    data === undefined
      ? {}
      : {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "x-crawl-token": token,
          },
          body: JSON.stringify(data),
        },
  );
  const value = await response.json();
  if (!response.ok) throw Error(value.error);
  console.log(JSON.stringify(value, null, 2));
}
if (command === "learn")
  await call("/api/game-research", {
    game: arg,
    force: process.argv.includes("--force"),
  });
else if (command === "list") await call("/api/tasks");
else if (command === "status")
  await call("/api/tasks/" + encodeURIComponent(arg));
else if (["retry", "cancel"].includes(command))
  await call(`/api/tasks/${encodeURIComponent(arg)}/${command}`, {});
else if (["select", "settings", "search", "subscribe"].includes(command)) {
  const input = JSON.parse(await readFile(arg, "utf8"));
  await call(
    {
      select: "/api/creative-jobs",
      settings: "/api/settings",
      search: "/api/search",
      subscribe: "/api/subscriptions",
    }[command],
    input,
  );
} else
  throw Error(
    "用法: learn 游戏名 [--force] | list | status/retry/cancel ID | search/select/settings/subscribe 本地JSON文件",
  );
