#!/usr/bin/env node
// scripts/docs-assets.mjs — publish docs/assets into the VitePress public dir (site/public, generated, gitignored).
// The canonical images live in docs/assets so GitHub renders them in README.md / ARCHITECTURE.md; the site serves the
// same files under /docs-assets/, plus favicons and social images at the site root.
import { cpSync, mkdirSync, rmSync } from 'node:fs';

const root = new URL('../', import.meta.url);
const pub = new URL('site/public/', root);
rmSync(pub, { recursive: true, force: true });
mkdirSync(pub, { recursive: true });
cpSync(new URL('docs/assets/', root), new URL('docs-assets/', pub), { recursive: true });
for (const f of ['favicon.svg', 'favicon-32.png', 'apple-touch-icon.png', 'og-image.png', 'mark.svg', 'mark-512.png'])
  cpSync(new URL(`docs/assets/brand/${f}`, root), new URL(f, pub));
cpSync(new URL('docs/assets/hero.svg', root), new URL('hero.svg', pub));
console.log('docs-assets: site/public populated');
