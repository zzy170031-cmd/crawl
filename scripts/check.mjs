import { readdir, readFile } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import { join } from "node:path";
import { root } from "../app/config.mjs";
let checked = 0;
async function walk(path) {
  for (const entry of await readdir(path, { withFileTypes: true })) {
    if (["node_modules", ".git", "data"].includes(entry.name)) continue;
    const full = join(path, entry.name);
    if (entry.isDirectory()) await walk(full);
    else if (/\.(mjs|js)$/.test(full)) {
      execFileSync(process.execPath, ["--check", full], { stdio: "pipe" });
      checked++;
    }
  }
}
await walk(root);
const skill = await readFile(
  join(root, "skills/douyin-hotspot-game-creation/SKILL.md"),
  "utf8",
);
if (!skill.startsWith("---\nname: douyin-hotspot-game-creation\n"))
  throw Error("技能frontmatter无效");
for (const match of skill.matchAll(/\]\((references\/[^)]+)\)/g))
  await readFile(join(root, "skills/douyin-hotspot-game-creation", match[1]));
console.log(`Checked ${checked} JS files and skill references`);
