// HTTP hook sink. Logs every request; response policy from ctl.json: {"<Event>": {"delayMs":n,"status":n,"body":{...}}}
import http from "node:http"; import fs from "node:fs";
const PORT = +process.argv[2], OUT = process.argv[3], CTL = new URL("./ctl.json", import.meta.url);
const ctl = () => { try { return JSON.parse(fs.readFileSync(CTL, "utf8")); } catch { return {}; } };
const log = (o) => fs.appendFileSync(OUT, JSON.stringify(o) + "\n");
http.createServer((req, res) => {
  const t0 = Date.now(); let b = "";
  req.on("data", c => b += c).on("end", () => {
    let body; try { body = JSON.parse(b); } catch { body = { raw: b }; }
    const ev = req.url.slice(1).split("?")[0];
    const pol = ctl()[ev] ?? {};
    log({ t: t0, kind: "req", method: req.method, url: req.url, httpVersion: req.httpVersion, headers: req.headers, rawHeaders: req.rawHeaders, bodyLen: b.length, body, policy: pol });
    let closed = false; req.socket.on("close", () => { closed = true; log({ t: Date.now(), kind: "sock-close", url: req.url, afterMs: Date.now() - t0 }); });
    setTimeout(() => {
      const out = pol.body === undefined ? "" : JSON.stringify(pol.body);
      try { res.writeHead(pol.status ?? 200, { "content-type": "application/json" }); res.end(out); } catch (e) {}
      log({ t: Date.now(), kind: "resp", url: req.url, status: pol.status ?? 200, out, heldMs: Date.now() - t0, clientGoneBefore: closed });
    }, pol.delayMs ?? 0);
  });
}).listen(PORT, "127.0.0.1", () => log({ t: Date.now(), kind: "listening", port: PORT }));
