#!/usr/bin/env node
// scripts/render-brand.mjs: rasterize the brand SVGs in docs/assets/brand to the PNGs that social platforms and
// browsers need (Open Graph, GitHub social preview, apple-touch-icon, PNG favicon). Uses a local headless Chrome:
//   CHROME=/path/to/chrome node scripts/render-brand.mjs
// The PNGs are committed; re-run this after editing an SVG.
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const DIR = new URL('../docs/assets/brand/', import.meta.url).pathname;
const CHROME =
  process.env.CHROME ??
  ['/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', '/usr/bin/google-chrome', '/usr/bin/chromium'].find(existsSync);
if (CHROME === undefined) {
  console.error('render-brand: no Chrome found; set CHROME=/path/to/chrome');
  process.exit(1);
}

const JOBS = [
  { svg: 'og-image.svg', png: 'og-image.png', w: 1200, h: 630 },
  { svg: 'social-preview.svg', png: 'social-preview.png', w: 1280, h: 640 },
  { svg: 'mark.svg', png: 'apple-touch-icon.png', w: 180, h: 180, bg: 'transparent' },
  { svg: 'favicon.svg', png: 'favicon-32.png', w: 32, h: 32, bg: 'transparent' },
  { svg: 'mark.svg', png: 'mark-512.png', w: 512, h: 512, bg: 'transparent' },
];

const FONTS = new URL('../node_modules/@fontsource-variable/', import.meta.url).href;
const FONT_CSS = `@font-face{font-family:'Geist';src:url('${FONTS}geist/files/geist-latin-wght-normal.woff2') format('woff2');font-weight:100 900}
@font-face{font-family:'Geist Mono';src:url('${FONTS}geist-mono/files/geist-mono-latin-wght-normal.woff2') format('woff2');font-weight:100 900}`;

const tmp = mkdtempSync(join(tmpdir(), 'ccd-brand-'));
try {
  for (const j of JOBS) {
    const svg = readFileSync(join(DIR, j.svg), 'utf8').replace(/<svg /, `<svg style="width:${j.w}px;height:${j.h}px;display:block" `);
    const html = join(tmp, `${j.png}.html`);
    writeFileSync(
      html,
      `<!doctype html><html><head><meta charset="utf-8"><style>${FONT_CSS}html,body{margin:0;padding:0;background:${j.bg ?? 'transparent'};overflow:hidden}</style></head><body>${svg}</body></html>`,
    );
    execFileSync(
      CHROME,
      [
        '--headless=new',
        '--disable-gpu',
        '--hide-scrollbars',
        '--force-device-scale-factor=1',
        '--default-background-color=00000000',
        `--window-size=${j.w},${j.h}`,
        `--screenshot=${join(DIR, j.png)}`,
        `file://${html}`,
      ],
      { stdio: 'pipe' },
    );
    console.log(`render-brand: ${j.png} (${j.w}×${j.h})`);
  }
} finally {
  rmSync(tmp, { recursive: true, force: true });
}
