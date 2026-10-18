import { mkdtemp, writeFile, unlink, rmdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { setTimeout as delay } from "node:timers/promises";
import { config } from "./config.mjs";
const exec = promisify(execFile);
export async function verifyExport(client, file_id, sheet_name, draft, signal) {
  const task = await client.call("manage_export_file", { file_id });
  if (!task.task_id) throw Error("导出任务未返回ID");
  let url;
  for (let i = 0; i < 12; i++) {
    signal?.throwIfAborted();
    await delay(5000, undefined, { signal });
    const p = await client.call("manage_export_progress", {
      task_id: task.task_id,
    });
    if (p.progress === 100) {
      url = p.file_url;
      break;
    }
  }
  if (!url) throw Error("导出未完成");
  const u = new URL(url);
  if (
    u.protocol !== "https:" ||
    !["qq.com", "qcloud.com", "myqcloud.com"].some(
      (h) => u.hostname === h || u.hostname.endsWith("." + h),
    )
  )
    throw Error("导出下载域名未支持");
  const response = await fetch(u, {
    redirect: "error",
    signal: AbortSignal.any([
      AbortSignal.timeout(45000),
      ...(signal ? [signal] : []),
    ]),
  });
  if (!response.ok) throw Error("导出下载失败");
  let size = 0;
  const chunks = [];
  for await (const b of response.body) {
    size += b.length;
    if (size > 32 * 1024 * 1024) throw Error("导出文件超过32MB限制");
    chunks.push(b);
  }
  const folder = await mkdtemp(join(tmpdir(), "crawl-export-"));
  try {
    await writeFile(join(folder, "book.xlsx"), Buffer.concat(chunks));
    await writeFile(
      join(folder, "expected.json"),
      JSON.stringify({ sheet_name, ...draft }),
    );
    const result = await exec(
      config.python,
      [
        fileURLToPath(new URL("verify_xlsx.py", import.meta.url)),
        join(folder, "book.xlsx"),
        join(folder, "expected.json"),
      ],
      { timeout: 30000, windowsHide: true, signal },
    );
    return JSON.parse(result.stdout);
  } finally {
    for (const name of ["book.xlsx", "expected.json"])
      await unlink(join(folder, name)).catch(() => {});
    await rmdir(folder).catch(() => {});
  }
}
