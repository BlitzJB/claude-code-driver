// capture tmux pane every 150ms, log full screen on change with ms timestamps
import { execFileSync } from "node:child_process"; import fs from "node:fs";
const T = process.argv[2], OUT = process.argv[3]; let prev = "";
setInterval(() => { let s; try { s = execFileSync("tmux", ["capture-pane", "-p", "-t", T], { encoding: "utf8" }); } catch { process.exit(0); }
  const trimmed = s.replace(/\s+$/gm, "").replace(/\n+$/, "");
  if (trimmed !== prev) { fs.appendFileSync(OUT, `=== ${Date.now()}\n${trimmed}\n`); prev = trimmed; } }, 150);
