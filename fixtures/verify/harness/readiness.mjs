import { execFileSync, spawnSync } from "node:child_process"; import fs from "node:fs";
const [,, sess, sid, cmdlog, tl] = process.argv; const T0 = Date.now(); const mark = (m) => fs.appendFileSync(tl, `${m} ${Date.now()} (+${Date.now()-T0})\n`);
mark("readiness-start(launch)");
const send = (k) => { execFileSync("tmux", ["send-keys", "-t", sess, "-l", k]); mark("sent:" + k); };
setTimeout(() => send("a"), 400);
setTimeout(() => send("c"), 1000);
const iv = setInterval(() => { let s = ""; try { s = fs.readFileSync(cmdlog, "utf8"); } catch {} if (s.includes(sid) && s.includes('"SessionStart"') && s.split("\n").some(l => l.includes(sid) && l.includes('"ev":"SessionStart"'))) { clearInterval(iv); mark("saw-SessionStart"); send("b"); setTimeout(() => { send("d"); }, 300); } }, 20);
setTimeout(() => process.exit(0), 8000);
