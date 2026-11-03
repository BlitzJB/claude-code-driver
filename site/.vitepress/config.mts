// site/.vitepress/config.mts — the GitHub Pages documentation site.
// Pages include the canonical markdown files from the repo root and docs/ (single source of truth). Their
// repo-relative links are rewritten: files that are site pages become site routes, everything else a GitHub link.
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineConfig, type DefaultTheme } from 'vitepress';

const REPO = 'https://github.com/BlitzJB/claude-code-driver';
const SITE = 'https://blitzjb.github.io/claude-code-driver/';
const DESCRIPTION =
  'Drive the interactive Claude Code TUI from Node.js: typed events, live state, permissions and interrupts, on your subscription.';
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')) as { version: string; claudeCodeVersion: string };

/** Repo file → site route (without .html). Anything else links to GitHub. */
const PAGES: Record<string, string> = {
  'README.md': '/guide/introduction',
  'docs/USAGE.md': '/guide/usage',
  'docs/KNOWN-LIMITATIONS.md': '/guide/limitations',
  'docs/MANUAL-TESTS.md': '/contributing/manual-tests',
  'ARCHITECTURE.md': '/architecture',
  'CONTRIBUTING.md': '/contributing/',
  'CODE_OF_CONDUCT.md': '/contributing/code-of-conduct',
  'SECURITY.md': '/security',
  'CHANGELOG.md': '/changelog',
  'docs/BRAND.md': '/brand',
};
/** Canonical files are written relative to their own directory; try both bases. */
function resolveRepoPath(href: string): string | undefined {
  for (const base of ['', 'docs/']) {
    const p = normalize(join(base, href)).replace(/^(\.\.\/)+/, '');
    if (PAGES[p] !== undefined || existsSync(join(ROOT, p))) return p;
  }
  return undefined;
}
/** Repo images (docs/assets/…) are published under /docs-assets/ by scripts/docs-assets.mjs. */
function rewriteSrc(src: string): string {
  if (/^([a-z]+:|\/)/i.test(src)) return src;
  const p = resolveRepoPath(src);
  return p !== undefined && p.startsWith('docs/assets/') ? `/docs-assets/${p.slice('docs/assets/'.length)}` : src;
}
function rewriteHref(href: string): string {
  if (/^([a-z]+:|#|\/)/i.test(href)) return href;
  const [path = '', hash] = href.split('#', 2) as [string, string | undefined];
  const p = resolveRepoPath(path);
  if (p === undefined) return href;
  const anchor = hash === undefined ? '' : `#${hash}`;
  const route = PAGES[p];
  if (route !== undefined) return `${route}${anchor}`;
  const kind = existsSync(join(ROOT, p)) && !/\.[a-z0-9]+$/i.test(p) ? 'tree' : 'blob';
  return `${REPO}/${kind}/main/${p}${anchor}`;
}

let apiSidebar: DefaultTheme.SidebarItem[] = [];
try {
  apiSidebar = JSON.parse(readFileSync(join(ROOT, 'site', 'api', 'typedoc-sidebar.json'), 'utf8')) as DefaultTheme.SidebarItem[];
} catch {
  /* API reference not generated yet (pnpm docs:api) */
}

export default defineConfig({
  title: 'claude-code-driver',
  description: DESCRIPTION,
  base: '/claude-code-driver/',
  cleanUrls: true,
  lastUpdated: true,
  srcExclude: ['**/README.md'],
  head: [
    ['link', { rel: 'icon', type: 'image/svg+xml', href: '/claude-code-driver/favicon.svg' }],
    ['link', { rel: 'icon', type: 'image/png', sizes: '32x32', href: '/claude-code-driver/favicon-32.png' }],
    ['link', { rel: 'apple-touch-icon', sizes: '180x180', href: '/claude-code-driver/apple-touch-icon.png' }],
    ['meta', { name: 'theme-color', content: '#0B1220' }],
    ['meta', { property: 'og:type', content: 'website' }],
    ['meta', { property: 'og:site_name', content: 'claude-code-driver' }],
    ['meta', { property: 'og:url', content: SITE }],
    ['meta', { property: 'og:image', content: `${SITE}og-image.png` }],
    ['meta', { property: 'og:image:width', content: '1200' }],
    ['meta', { property: 'og:image:height', content: '630' }],
    ['meta', { property: 'og:image:alt', content: 'claude-code-driver: drive the interactive Claude Code TUI from Node.js' }],
    ['meta', { name: 'twitter:card', content: 'summary_large_image' }],
    ['meta', { name: 'twitter:image', content: `${SITE}og-image.png` }],
  ],
  transformPageData(pageData) {
    // per-page social titles/descriptions; the image stays the brand card
    const title = (pageData.frontmatter['title'] as string | undefined) ?? pageData.title;
    const head = ((pageData.frontmatter['head'] as [string, Record<string, string>][] | undefined) ??= []);
    pageData.frontmatter['head'] = head;
    head.push(['meta', { property: 'og:title', content: title ? `${title} | claude-code-driver` : 'claude-code-driver' }]);
    head.push(['meta', { property: 'og:description', content: pageData.description || DESCRIPTION }]);
  },
  markdown: {
    config(md) {
      md.core.ruler.push('ccd-rewrite-links', (state) => {
        // raw HTML (e.g. the README banner): repo-relative src → the public /docs-assets/ path (Vite adds the base)
        const html = (c: string): string =>
          c.replace(/\bsrc="([^"]+)"/g, (m, src: string) => {
            const r = rewriteSrc(src);
            return r === src ? m : `src="${r}"`;
          });
        for (const block of state.tokens) {
          if (block.type === 'html_block') block.content = html(block.content);
          for (const t of block.children ?? []) if (t.type === 'html_inline') t.content = html(t.content);
        }
        for (const block of state.tokens)
          for (const t of block.children ?? [])
            if (t.type === 'link_open') {
              const href = t.attrGet('href');
              if (href !== null) t.attrSet('href', rewriteHref(href));
            } else if (t.type === 'image') {
              const src = t.attrGet('src');
              if (src !== null) t.attrSet('src', rewriteSrc(src));
            }
      });
    },
  },
  themeConfig: {
    logo: { src: '/mark.svg', alt: 'claude-code-driver' },
    nav: [
      { text: 'Guide', link: '/guide/introduction', activeMatch: '/guide/' },
      { text: 'Architecture', link: '/architecture' },
      { text: 'API', link: '/api/', activeMatch: '/api/' },
      { text: 'Contributing', link: '/contributing/', activeMatch: '/contributing/' },
      {
        text: `v${pkg.version}`,
        items: [
          { text: 'Changelog', link: '/changelog' },
          { text: `Claude Code ${pkg.claudeCodeVersion}`, link: '/guide/limitations' },
          { text: 'Brand', link: '/brand' },
        ],
      },
    ],
    sidebar: {
      '/guide/': [
        {
          text: 'Guide',
          items: [
            { text: 'Introduction', link: '/guide/introduction' },
            { text: 'Getting started', link: '/guide/getting-started' },
            { text: 'Usage', link: '/guide/usage' },
            { text: 'Known limitations', link: '/guide/limitations' },
          ],
        },
        {
          text: 'Reference',
          items: [
            { text: 'Architecture', link: '/architecture' },
            { text: 'API reference', link: '/api/' },
          ],
        },
      ],
      '/api/': [{ text: 'API reference', items: apiSidebar }],
      '/contributing/': [
        {
          text: 'Contributing',
          items: [
            { text: 'Contributing guide', link: '/contributing/' },
            { text: 'Manual tests', link: '/contributing/manual-tests' },
            { text: 'Code of conduct', link: '/contributing/code-of-conduct' },
            { text: 'Security policy', link: '/security' },
          ],
        },
      ],
    },
    socialLinks: [{ icon: 'github', link: REPO }],
    editLink: {
      // Included pages edit their canonical file; generated API pages edit the source of the public types.
      pattern: ({ filePath }) => {
        const route = `/${filePath.replace(/\.md$/, '').replace(/(^|\/)index$/, '$1')}`;
        const canonical = Object.entries(PAGES).find(([, r]) => r === route)?.[0];
        if (canonical !== undefined) return `${REPO}/edit/main/${canonical}`;
        if (filePath.startsWith('api/')) return `${REPO}/blob/main/src/api/public-types.ts`;
        return `${REPO}/edit/main/site/${filePath}`;
      },
      text: 'Edit this page on GitHub',
    },
    search: { provider: 'local' },
    outline: { level: [2, 3] },
    footer: {
      message: 'Released under the MIT License. Not affiliated with Anthropic.',
      copyright: 'Copyright © 2026 BlitzJB and contributors',
    },
  },
});
