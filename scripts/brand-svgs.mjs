#!/usr/bin/env node
// scripts/brand-svgs.mjs: generate every brand SVG in docs/assets from one OKLCH token table (docs/BRAND.md).
//   node scripts/brand-svgs.mjs && node scripts/render-brand.mjs
// Reference: tmux's own status line, the solid bar along the foot of every tmux session. The library runs Claude Code
// inside tmux, so the mark is a pane with that bar, and the illustrations are literal tmux windows.
// SVGs carry sRGB hex (converted here) because some image renderers do not parse oklch() in presentation attributes.
import { writeFileSync } from 'node:fs';

// ---------- tokens (OKLCH: lightness, chroma, hue) ----------
const T = {
  graphite950: [0.19, 0.01, 150],
  graphite900: [0.23, 0.012, 150],
  graphite800: [0.29, 0.013, 150],
  graphite700: [0.38, 0.014, 150],
  graphite500: [0.52, 0.014, 150],
  graphite400: [0.66, 0.014, 150],
  graphite200: [0.88, 0.009, 150],
  paper50: [0.985, 0.004, 150],
  paper100: [0.962, 0.006, 150],
  status500: [0.78, 0.165, 148], // the status line
  status700: [0.5, 0.125, 150], // status green as text on paper (5.4:1)
  status100: [0.95, 0.035, 150],
  // channel roles (diagrams): hooks = status green, transcript = sky, network = amber, screen = coral, registry = slate
  sky700: [0.5, 0.1, 240],
  sky100: [0.95, 0.025, 240],
  amber700: [0.54, 0.11, 70],
  amber100: [0.96, 0.035, 85],
  coral700: [0.52, 0.14, 25],
  coral100: [0.95, 0.03, 25],
  slate700: [0.48, 0.035, 260],
  slate100: [0.95, 0.01, 260],
  sky400: [0.76, 0.1, 235],
  amber400: [0.82, 0.13, 82],
  coral400: [0.73, 0.13, 25],
};
function hex([L, C, h]) {
  const a = C * Math.cos((h * Math.PI) / 180);
  const b = C * Math.sin((h * Math.PI) / 180);
  const l = (L + 0.3963377774 * a + 0.2158037573 * b) ** 3;
  const m = (L - 0.1055613458 * a - 0.0638541728 * b) ** 3;
  const s = (L - 0.0894841775 * a - 1.291485548 * b) ** 3;
  const rgb = [
    4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s,
    -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s,
    -0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s,
  ];
  const enc = (x) => {
    const c = Math.max(0, Math.min(1, x));
    return Math.round((c <= 0.0031308 ? 12.92 * c : 1.055 * c ** (1 / 2.4) - 0.055) * 255);
  };
  return `#${rgb
    .map((x) => enc(x).toString(16).padStart(2, '0'))
    .join('')
    .toUpperCase()}`;
}
const C = Object.fromEntries(Object.entries(T).map(([k, v]) => [k, hex(v)]));

const MONO = "'Geist Mono',ui-monospace,'SF Mono',Menlo,Consolas,monospace";
const SANS = "'Geist',ui-sans-serif,system-ui,-apple-system,'Segoe UI',Helvetica,Arial,sans-serif";
const OUT = new URL('../docs/assets/', import.meta.url);
const write = (rel, svg) => writeFileSync(new URL(rel, OUT), `${svg.trim()}\n`);
const esc = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

// ---------- the mark: a tmux pane with its status line ----------
function markBody() {
  return `<rect width="64" height="64" rx="14" fill="${C.graphite900}"/>
  <path d="M0 49H64V50C64 57.7 57.7 64 50 64H14C6.3 64 0 57.7 0 50Z" fill="${C.status500}"/>
  <rect x="8" y="53" width="9" height="7" rx="1.5" fill="${C.graphite900}"/>
  <rect x="42" y="55.5" width="14" height="2" rx="1" fill="${C.graphite900}" fill-opacity=".55"/>
  <path d="M15 19L26 28L15 37" fill="none" stroke="${C.paper100}" stroke-width="5.5" stroke-linecap="round" stroke-linejoin="round"/>
  <rect x="30" y="33" width="15" height="5" rx="2" fill="${C.paper100}" fill-opacity=".9"/>`;
}
const mark = (size = 64) =>
  `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64" width="${size}" height="${size}" role="img" aria-label="claude-code-driver">
  ${markBody()}
</svg>`;
write('brand/mark.svg', mark());
write('brand/favicon.svg', mark());

const wordmark = (dark) =>
  `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 520 80" width="520" height="80" role="img" aria-label="claude-code-driver">
  <g transform="translate(4 4) scale(1.125)">${markBody()}</g>
  <text x="92" y="52" font-family="${MONO}" font-size="31" font-weight="600" letter-spacing="-0.6"><tspan fill="${dark ? C.graphite200 : C.graphite700}">claude-code-</tspan><tspan fill="${dark ? C.status500 : C.status700}">driver</tspan></text>
</svg>`;
write('brand/wordmark.svg', wordmark(false));
write('brand/wordmark-dark.svg', wordmark(true));

// ---------- a tmux window: Claude's TUI above, your program's events below, the status line at the foot ----------
function tmuxWindow(x, y, w, h, scale = 1) {
  const f = (n) => n * scale;
  const pad = f(22);
  const bar = f(30);
  const split = y + Math.round((h - bar) * 0.5);
  const line = (yy, parts) =>
    `<text x="${x + pad}" y="${yy}" font-family="${MONO}" font-size="${f(14.5)}">${parts.map(([t, c, wgt]) => `<tspan fill="${c}"${wgt ? ` font-weight="${wgt}"` : ''}>${esc(t)}</tspan>`).join('')}</text>`;
  const top = [
    line(y + f(40), [
      ['❯ ', C.status500],
      ['refactor the auth module', C.paper100],
    ]),
    line(y + f(68), [
      ['⏺ ', C.graphite400],
      ['Edit(src/auth.ts)', C.graphite200],
    ]),
    line(y + f(90), [
      ['  ⎿ ', C.graphite500],
      ['Do you want to make this edit?', C.graphite400],
    ]),
    line(y + f(118), [
      ['✻ ', C.amber400],
      ['Working… ', C.amber400],
      ['(12s · 2.1k tokens)', C.graphite500],
    ]),
  ];
  const ev = [
    ['toolStarted', 'Edit', 'hook'],
    ['permissionRequested', 'allow', 'policy'],
    ['text', '"Done. Tests pass."', ''],
    ['turnEnded', 'completed', '41s'],
  ];
  // SVG collapses runs of spaces, so columns get explicit x positions (Geist Mono advance is 0.6em)
  const ch = f(14.5) * 0.6;
  const col = (yy, t, cx, c, wgt) =>
    `<text x="${x + pad + cx * ch}" y="${yy}" font-family="${MONO}" font-size="${f(14.5)}" fill="${c}"${wgt ? ` font-weight="${wgt}"` : ''}>${esc(t)}</text>`;
  const bottom = ev.map(([e, a, b], i) => {
    const yy = split + f(34) + i * f(26);
    return [col(yy, e, 0, C.status500, 600), col(yy, a, 21, C.paper100), b ? col(yy, b, 32, C.graphite500) : ''].join('');
  });
  return `<g>
    <rect x="${x}" y="${y}" width="${w}" height="${h}" rx="${f(16)}" fill="${C.graphite900}"/>
    <line x1="${x}" y1="${split}" x2="${x + w}" y2="${split}" stroke="${C.status500}" stroke-width="${f(1.5)}"/>
    ${top.join('\n    ')}
    ${bottom.join('\n    ')}
    <path d="M${x} ${y + h - bar}H${x + w}V${y + h - f(16)}a${f(16)} ${f(16)} 0 0 1 -${f(16)} ${f(16)}H${x + f(16)}a${f(16)} ${f(16)} 0 0 1 -${f(16)} -${f(16)}Z" fill="${C.status500}"/>
    <text x="${x + pad}" y="${y + h - bar / 2 + f(5)}" font-family="${MONO}" font-size="${f(13.5)}" fill="${C.graphite950}"><tspan font-weight="700">[ccd]</tspan>  0:claude*  1:events</text>
    <text x="${x + w - pad}" y="${y + h - bar / 2 + f(5)}" text-anchor="end" font-family="${MONO}" font-size="${f(13.5)}" fill="${C.graphite950}">"auth" 14:02</text>
  </g>`;
}

// ---------- social cards ----------
function card(W, H) {
  const m = 72;
  const paneW = Math.round(W * 0.43);
  const paneH = H - 2 * m - 40;
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${H}" width="${W}" height="${H}" role="img" aria-label="claude-code-driver: drive the interactive Claude Code TUI from Node.js">
  <rect width="${W}" height="${H}" fill="${C.paper100}"/>
  <g transform="translate(${m} ${m}) scale(1.25)">${markBody()}</g>
  <text x="${m}" y="${m + 168}" font-family="${MONO}" font-size="50" font-weight="600" letter-spacing="-1.2"><tspan fill="${C.graphite900}">claude-code-</tspan><tspan fill="${C.status700}">driver</tspan></text>
  <text font-family="${SANS}" font-size="31" font-weight="450" fill="${C.graphite700}">
    <tspan x="${m}" y="${m + 228}">Drive the interactive Claude Code TUI</tspan>
    <tspan x="${m}" y="${m + 270}">from Node.js, on your subscription.</tspan>
  </text>
  <text x="${m}" y="${H - m + 6}" font-family="${MONO}" font-size="19" fill="${C.graphite500}">github.com/BlitzJB/claude-code-driver</text>
  ${tmuxWindow(W - m - paneW, m, paneW, paneH + 40, 1)}
</svg>`;
}
write('brand/og-image.svg', card(1200, 630));
write('brand/social-preview.svg', card(1280, 640));

// ---------- home page hero and README banner ----------
write(
  'hero.svg',
  `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 520 380" width="520" height="380" role="img" aria-label="A tmux window: Claude Code's TUI in the top pane, the typed events your program receives in the bottom pane">
  ${tmuxWindow(0, 0, 520, 380, 1)}
</svg>`,
);
write(
  'banner.svg',
  `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1200 260" width="1200" height="260" role="img" aria-label="claude-code-driver: run the real Claude Code TUI in tmux and drive it from Node.js">
  <rect x=".75" y=".75" width="1198.5" height="258.5" rx="20" fill="${C.paper100}" stroke="${C.graphite200}" stroke-width="1.5"/>
  <g transform="translate(56 56) scale(1.25)">${markBody()}</g>
  <text x="160" y="104" font-family="${MONO}" font-size="44" font-weight="600" letter-spacing="-1"><tspan fill="${C.graphite900}">claude-code-</tspan><tspan fill="${C.status700}">driver</tspan></text>
  <text x="160" y="148" font-family="${SANS}" font-size="23" fill="${C.graphite700}">Run the real Claude Code TUI in tmux and drive it from Node.js.</text>
  <path d="M.75 214H1199.25V239.25A19.25 19.25 0 0 1 1180 258.5H20A19.25 19.25 0 0 1 .75 239.25Z" fill="${C.status500}"/>
  <text x="56" y="241" font-family="${MONO}" font-size="16" fill="${C.graphite950}"><tspan font-weight="700">[ccd]</tspan>  0:claude*  1:events</text>
  <text x="1144" y="241" text-anchor="end" font-family="${MONO}" font-size="16" fill="${C.graphite950}">hooks  transcript  screen  network</text>
</svg>`,
);

// ---------- diagrams (paper panels, full borders in role colors) ----------
const MARKERS = `<defs>
    <marker id="arr" viewBox="0 0 10 10" refX="8" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse"><path d="M0 0L10 5L0 10z" fill="${C.graphite500}"/></marker>
    <marker id="arrG" viewBox="0 0 10 10" refX="8" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse"><path d="M0 0L10 5L0 10z" fill="${C.status700}"/></marker>
  </defs>`;
const panel = (w, h, label, title, sub, body) =>
  `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${w} ${h}" width="${w}" height="${h}" role="img" aria-label="${label}">
  ${MARKERS}
  <rect x=".75" y=".75" width="${w - 1.5}" height="${h - 1.5}" rx="18" fill="${C.paper50}" stroke="${C.graphite200}" stroke-width="1.5"/>
  <text x="40" y="54" font-family="${SANS}" font-size="23" font-weight="650" fill="${C.graphite900}" letter-spacing="-0.3">${title}</text>
  <text x="40" y="82" font-family="${SANS}" font-size="15.5" fill="${C.graphite500}">${sub}</text>
${body}
</svg>`;
const tagPill = (x, y, t, stroke, text) =>
  `<rect x="${x}" y="${y}" width="${t.length * 9.2 + 20}" height="26" rx="13" fill="${C.paper50}" stroke="${stroke}"/><text x="${x + 10}" y="${y + 17.5}" font-family="${MONO}" font-size="13" font-weight="600" fill="${text}">${t}</text>`;

// layers
{
  const rows = [
    [
      'L4',
      'api/',
      'ClaudeSession, Turn, options and the event, state and error mappers',
      'public, semver-stable',
      C.status700,
      C.status100,
    ],
    ['L3.5', 'runtime/', 'the composition root that builds the real ports and wires the kernel', 'wiring only', C.status700, C.paper100],
    ['L3', 'session/', 'step loop, scheduler, launcher, input executor, permission broker, lifecycle', 'impure, async', C.sky700, C.sky100],
    ['L2', 'core/', 'step(core, input) returns the next core, events and intents', 'pure, deterministic', C.slate700, C.slate100],
    ['L1', 'channels/', 'normalizers and the Claude Code 2.1.316 profile', 'raw data to observations', C.amber700, C.amber100],
    ['L0', 'platform/', 'tmux, transcript tail, hook servers, proxy sidecar, processes, settings', 'OS adapters', C.coral700, C.coral100],
  ];
  let y = 110;
  let b = '';
  rows.forEach(([lv, mod, desc, tag, stroke, fill], i) => {
    b += `  <g>
    <rect x="40" y="${y}" width="840" height="64" rx="12" fill="${fill}" stroke="${stroke}" stroke-opacity=".7" stroke-width="1.5"/>
    ${tagPill(58, y + 19, lv, stroke, stroke)}
    <text x="128" y="${y + 28}" font-family="${MONO}" font-size="17" font-weight="600" fill="${C.graphite900}">${mod}</text>
    <text x="128" y="${y + 50}" font-family="${SANS}" font-size="14.5" fill="${C.graphite700}">${desc}</text>
    <text x="862" y="${y + 38}" text-anchor="end" font-family="${MONO}" font-size="12.5" fill="${C.graphite500}">${tag}</text>
  </g>\n`;
    y += 76;
    if (i === 0) {
      b += `  <g><line x1="60" y1="${y - 6}" x2="860" y2="${y - 6}" stroke="${C.status700}" stroke-width="1.5" stroke-dasharray="5 6"/>
    <rect x="364" y="${y - 19}" width="192" height="26" rx="13" fill="${C.status500}"/>
    <text x="460" y="${y - 1.5}" text-anchor="middle" font-family="${MONO}" font-size="13" font-weight="600" fill="${C.graphite950}">SessionKernel port</text></g>\n`;
      y += 16;
    }
  });
  b += `  <text x="40" y="${y + 18}" font-family="${SANS}" font-size="14" fill="${C.graphite500}">model/ holds the shared types and imports nothing. testing/ holds the fakes and replay tools, and nothing imports it.</text>\n`;
  write(
    'layers.svg',
    panel(
      920,
      y + 46,
      'claude-code-driver layer diagram',
      'Layers',
      'Each layer imports only the layers below it. The public API reaches the rest through one port.',
      b,
    ),
  );
}

// channels
{
  const ch = [
    ['process', '6', 'pane exit and its status', C.graphite700, C.paper100],
    ['hooks', '5', 'prompt acks, tools, permissions, text', C.status700, C.status100],
    ['transcript', '4', 'interrupts, denials, model calls, final text', C.sky700, C.sky100],
    ['network', '3', 'bytes flowing or stalled (opt-in)', C.amber700, C.amber100],
    ['registry', '2', 'pid and version cross-check', C.slate700, C.slate100],
    ['screen', '1', 'retry banners, dialogs, startup gates', C.coral700, C.coral100],
  ];
  let b = '';
  ch.forEach(([n, r, d, stroke, fill], i) => {
    const y = 114 + i * 66;
    b += `  <g>
    <rect x="40" y="${y}" width="390" height="52" rx="12" fill="${fill}" stroke="${stroke}" stroke-opacity=".7" stroke-width="1.5"/>
    <text x="60" y="${y + 22}" font-family="${MONO}" font-size="16" font-weight="600" fill="${C.graphite900}">${n}</text>
    <text x="60" y="${y + 42}" font-family="${SANS}" font-size="13.5" fill="${C.graphite700}">${d}</text>
    <circle cx="404" cy="${y + 26}" r="14" fill="${C.paper50}" stroke="${stroke}"/>
    <text x="404" y="${y + 31}" text-anchor="middle" font-family="${MONO}" font-size="14" font-weight="700" fill="${stroke}">${r}</text>
    <path d="M430 ${y + 26}C480 ${y + 26} 480 322 530 322" fill="none" stroke="${stroke}" stroke-opacity=".55" stroke-width="2"/>
  </g>\n`;
  });
  b += `  <g>
    <rect x="530" y="262" width="180" height="120" rx="14" fill="${C.graphite900}"/>
    <text x="620" y="300" text-anchor="middle" font-family="${MONO}" font-size="18" font-weight="600" fill="${C.status500}">core</text>
    <text x="620" y="325" text-anchor="middle" font-family="${SANS}" font-size="13.5" fill="${C.graphite200}">merges by authority</text>
    <text x="620" y="346" text-anchor="middle" font-family="${SANS}" font-size="13.5" fill="${C.graphite200}">joins on real ids</text>
    <path d="M710 304H760" stroke="${C.status700}" stroke-width="2" marker-end="url(#arrG)"/>
    <path d="M710 340H760" stroke="${C.status700}" stroke-width="2" marker-end="url(#arrG)"/>
    <rect x="766" y="284" width="114" height="40" rx="10" fill="${C.paper50}" stroke="${C.status700}"/>
    <text x="823" y="309" text-anchor="middle" font-family="${MONO}" font-size="14" fill="${C.graphite900}">events</text>
    <rect x="766" y="324" width="114" height="40" rx="10" fill="${C.paper50}" stroke="${C.status700}"/>
    <text x="823" y="349" text-anchor="middle" font-family="${MONO}" font-size="14" fill="${C.graphite900}">state</text>
  </g>
  <text x="40" y="530" font-family="${SANS}" font-size="14" fill="${C.graphite500}">The number is the authority rank. Screen facts never count as confirmed.</text>\n`;
  write(
    'channels.svg',
    panel(
      920,
      558,
      'Observation channels and their authority order',
      'Observation channels',
      'Every fact remembers its source, and a higher-ranked source replaces a lower one.',
      b,
    ),
  );
}

// step cycle
{
  const box = (
    x,
    y,
    w,
    t,
    s,
    stroke,
    fill,
    tc = C.graphite900,
    sc = C.graphite700,
  ) => `  <g><rect x="${x}" y="${y}" width="${w}" height="66" rx="13" fill="${fill}" stroke="${stroke}" stroke-opacity=".75" stroke-width="1.5"/>
    <text x="${x + w / 2}" y="${y + 29}" text-anchor="middle" font-family="${MONO}" font-size="15.5" font-weight="600" fill="${tc}">${t}</text>
    <text x="${x + w / 2}" y="${y + 50}" text-anchor="middle" font-family="${SANS}" font-size="13" fill="${sc}">${s}</text></g>\n`;
  const lbl = (x, y, t, a = 'middle') =>
    `  <text x="${x}" y="${y}" text-anchor="${a}" font-family="${MONO}" font-size="12.5" fill="${C.graphite500}">${t}</text>\n`;
  const y = 124;
  const mid = y + 33;
  const yb = 296;
  let b = '';
  b += box(40, y, 190, 'L0 adapters', 'tmux, tail, hooks, proxy', C.coral700, C.coral100);
  b += box(300, y, 190, 'L1 normalizers', 'raw data to observations', C.amber700, C.amber100);
  b += box(560, y, 190, 'L2 step()', 'the pure reducer', C.slate700, C.slate100);
  b += box(790, y, 90, 'events', 'to you', C.graphite900, C.graphite900, C.status500, C.graphite200);
  b += `  <path d="M230 ${mid}H294" stroke="${C.graphite500}" stroke-width="2" marker-end="url(#arr)"/>\n` + lbl(262, mid - 12, 'raw');
  b += `  <path d="M490 ${mid}H554" stroke="${C.graphite500}" stroke-width="2" marker-end="url(#arr)"/>\n` + lbl(522, mid - 12, 'obs');
  b += `  <path d="M750 ${mid}H784" stroke="${C.status700}" stroke-width="2" marker-end="url(#arrG)"/>\n`;
  b += box(300, yb, 190, 'L3 executors', 'intents to I/O', C.sky700, C.sky100);
  b +=
    `  <path d="M655 ${y + 66}V${yb + 33}H496" fill="none" stroke="${C.graphite500}" stroke-width="2" marker-end="url(#arr)"/>\n` +
    lbl(668, yb - 6, 'intents', 'start');
  b +=
    `  <path d="M300 ${yb + 33}H135V${y + 72}" fill="none" stroke="${C.graphite500}" stroke-width="2" marker-end="url(#arr)"/>\n` +
    lbl(150, yb + 22, 'keys, answers, polls', 'start');
  b += `  <text x="40" y="408" font-family="${SANS}" font-size="14" fill="${C.graphite500}">L3 runs one decision timer at the core's next deadline and feeds the tick back in as an observation.</text>\n`;
  write(
    'step-cycle.svg',
    panel(
      920,
      436,
      'The observe, step, execute cycle',
      'One cycle',
      'Time enters as data, so a recorded trace replays to the same events and state.',
      b,
    ),
  );
}

console.log('brand-svgs: wrote docs/assets/{brand/*,hero,banner,layers,channels,step-cycle}.svg');
export { C as COLORS, T as TOKENS };
