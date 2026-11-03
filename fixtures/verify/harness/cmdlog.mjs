import fs from "node:fs";
const ev = process.argv[2]; const t0 = Date.now(); let d = "";
process.stdin.on("data", c => d += c).on("end", () => {
  let p; try { p = JSON.parse(d); } catch { p = { raw: d }; }
  fs.appendFileSync(process.env.CMDLOG, JSON.stringify({ t: t0, ev, p }) + "\n");
});
