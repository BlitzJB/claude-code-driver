// site/.vitepress/config.mts — the GitHub Pages documentation site.
// Pages include the canonical markdown files from the repo root and docs/ (single source of truth). Their
// repo-relative links are rewritten: files that are site pages become site routes, everything else a GitHub link.
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineConfig, type DefaultTheme } from 'vitepress';

const REPO = 'https://github.com/BlitzJB/claude-code-driver';
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
};
/** Canonical files are written relative to their own directory; try both bases. */
function resolveRepoPath(href: string): string | undefined {
  for (const base of ['', 'docs/']) {
    const p = normalize(join(base, href)).replace(/^(\.\.\/)+/, '');
    if (PAGES[p] !== undefined || existsSync(join(ROOT, p))) return p;
  }
  return undefined;
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
  description:
    'Drive the interactive Claude Code TUI from Node.js: typed events, live state, permissions and interrupts, on your subscription.',
  base: '/claude-code-driver/',
  cleanUrls: true,
  lastUpdated: true,
  srcExclude: ['**/README.md'],
  head: [
    ['meta', { name: 'theme-color', content: '#d97757' }],
    ['meta', { property: 'og:title', content: 'claude-code-driver' }],
    ['meta', { property: 'og:description', content: 'Drive the interactive Claude Code TUI from Node.js.' }],
  ],
  markdown: {
    config(md) {
      md.core.ruler.push('ccd-rewrite-links', (state) => {
        for (const block of state.tokens)
          for (const t of block.children ?? [])
            if (t.type === 'link_open') {
              const href = t.attrGet('href');
              if (href !== null) t.attrSet('href', rewriteHref(href));
            }
      });
    },
  },
  themeConfig: {
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
