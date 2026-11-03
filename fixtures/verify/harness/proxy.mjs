import net from "node:net"; import fs from "node:fs";
const PORT = +process.argv[2], OUT = process.argv[3];
const log = (o) => fs.appendFileSync(OUT, JSON.stringify({ t: Date.now(), ...o }) + "\n");
net.createServer(c => { c.on("error", () => {}); c.once("data", buf => {
  const first = buf.toString("latin1").split("\r\n")[0]; const m = /^CONNECT ([^:\s]+):(\d+)/.exec(first);
  if (!m) { log({ kind: "NON-CONNECT", first }); c.end("HTTP/1.1 502 Bad Gateway\r\nContent-Length: 0\r\n\r\n"); return; }
  log({ kind: "CONNECT", host: m[1], port: m[2] });
  const u = net.connect(+m[2], m[1], () => { c.write("HTTP/1.1 200 Connection Established\r\n\r\n"); c.pipe(u); u.pipe(c); });
  u.on("error", e => { log({ kind: "UPERR", host: m[1], code: e.code }); c.destroy(); }); c.on("close", () => u.destroy()); u.on("close", () => c.destroy());
}); }).listen(PORT, "127.0.0.1", () => log({ kind: "listening", port: PORT }));
