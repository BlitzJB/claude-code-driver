// poll ~/.claude/projects/*<match>*/**/*.jsonl every 20ms, log each new line with first-seen time
import fs from "node:fs"; import path from "node:path"; import os from "node:os";
const MATCH = process.argv[2], OUT = process.argv[3], root = path.join(os.homedir(), ".claude/projects");
const off = new Map(), buf = new Map();
const walk = (d, acc) => { for (const e of fs.readdirSync(d, { withFileTypes: true })) { const p = path.join(d, e.name); if (e.isDirectory()) walk(p, acc); else if (p.endsWith(".jsonl")) acc.push(p); } return acc; };
setInterval(() => {
  const now = Date.now(); let files = [];
  try { for (const d of fs.readdirSync(root)) if (d.includes(MATCH)) walk(path.join(root, d), files); } catch {}
  for (const f of files) {
    let st; try { st = fs.statSync(f); } catch { continue; }
    const o = off.get(f) ?? 0; if (!off.has(f)) fs.appendFileSync(OUT, JSON.stringify({ seen: now, kind: "new-file", f }) + "\n");
    if (st.size <= o) { off.set(f, o); continue; }
    const fd = fs.openSync(f, "r"); const b = Buffer.alloc(st.size - o); fs.readSync(fd, b, 0, b.length, o); fs.closeSync(fd); off.set(f, st.size);
    const s = (buf.get(f) ?? "") + b.toString("utf8"); const lines = s.split("\n"); buf.set(f, lines.pop());
    for (const l of lines) { if (!l.trim()) continue; let j; try { j = JSON.parse(l); } catch { j = {}; }
      const c = j.message?.content; const blocks = Array.isArray(c) ? c.map(x => ({ type: x.type, id: x.id, tool_use_id: x.tool_use_id, name: x.name })) : undefined;
      fs.appendFileSync(OUT, JSON.stringify({ seen: now, f: path.basename(f), type: j.type, subtype: j.subtype, ts: j.timestamp, uuid: j.uuid, sessionId: j.sessionId, promptId: j.promptId, msgId: j.message?.id, blocks, toolUseID: j.toolUseID, raw: l.length < 4000 ? j : undefined }) + "\n"); }
  }
}, 20);
