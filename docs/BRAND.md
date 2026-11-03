# Brand

The mark is a tmux pane with its status line. tmux draws that solid bar along the foot of every session, and this
library runs Claude Code inside tmux, so the bar is the one shape that belongs to the project and to nothing else.

The project is independent and not affiliated with Anthropic. Keep the mark away from Anthropic and Claude logos, and
do not use Anthropic's brand colors.

## Assets

Every SVG comes from `scripts/brand-svgs.mjs`, which holds the color tokens. Edit the script, then run
`pnpm brand:render` to rewrite the SVGs and the PNGs (headless Chrome; set `CHROME=/path/to/chrome` if it is not in a
standard place).

| Asset | Files | Use |
| --- | --- | --- |
| Mark | [mark.svg](assets/brand/mark.svg), [mark-512.png](assets/brand/mark-512.png) | avatars, the site nav, anywhere square |
| Wordmark | [wordmark.svg](assets/brand/wordmark.svg) for light grounds, [wordmark-dark.svg](assets/brand/wordmark-dark.svg) for dark | headers |
| Favicon | [favicon.svg](assets/brand/favicon.svg), [favicon-32.png](assets/brand/favicon-32.png), [apple-touch-icon.png](assets/brand/apple-touch-icon.png) | browsers and home screens |
| Link preview | [og-image.png](assets/brand/og-image.png) (1200×630) | the site's `og:image` and `twitter:image` |
| GitHub social preview | [social-preview.png](assets/brand/social-preview.png) (1280×640) | repository settings, social preview |
| README banner | [banner.svg](assets/banner.svg) | the top of the README |
| Diagrams | [layers.svg](assets/layers.svg), [channels.svg](assets/channels.svg), [step-cycle.svg](assets/step-cycle.svg), [hero.svg](assets/hero.svg) | the docs and the site |

![The mark](assets/brand/mark.svg)

## Color

Colors are defined in OKLCH and tinted toward hue 150, the hue of the status green. The SVGs use the sRGB hex values
below because some image renderers do not parse `oklch()`.

| Token | OKLCH | Hex | Role |
| --- | --- | --- | --- |
| Status | `oklch(0.78 0.165 148)` | `#62D378` | the status line, the one accent on dark grounds |
| Status ink | `oklch(0.50 0.125 150)` | `#1B763A` | the accent as text and buttons on paper (5.4:1) |
| Graphite 950 | `oklch(0.19 0.010 150)` | `#111511` | dark page ground |
| Graphite 900 | `oklch(0.23 0.012 150)` | `#191F1A` | the mark, panes, primary text on paper (16:1) |
| Graphite 700 | `oklch(0.38 0.014 150)` | `#3D453E` | secondary text on paper |
| Graphite 500 | `oklch(0.52 0.014 150)` | `#636B65` | captions, arrows |
| Graphite 200 | `oklch(0.88 0.009 150)` | `#D3D9D4` | rules and borders on paper |
| Paper 100 | `oklch(0.962 0.006 150)` | `#F0F4F0` | cards and the banner |
| Paper 50 | `oklch(0.985 0.004 150)` | `#F8FBF9` | light page ground |

Diagrams use four more colors, one per observation channel, and each always means the same thing. Hooks are status
green, the transcript is sky (`#1F6A96`), the network is amber (`#976213`) and the screen is coral (`#AB413E`). The core
and the registry use slate (`#525E72`).

The site follows the reader's system setting, and the light theme is the default design. Most people read these docs
on a laptop in daylight with an editor open beside them.

## Type

The site and the artwork use Geist for prose and Geist Mono for the wordmark, code and labels. Both are bundled with
the site, so pages do not depend on a font CDN. The wordmark is lowercase `claude-code-driver`, with `driver` in the
status color.

## Diagrams

Draw each diagram as an SVG with its own paper panel, so it reads the same on light pages, dark pages and GitHub.
Use full borders in a role color, never a colored stripe on one side, and no glows or gradient text. Keep text at
12.5 px or larger at the native width of 920 px, and label every arrow.

## Copy

Write brand copy in plain sentences. Describe what the library does and how, with no slogans, no em dashes and no
colons joining two halves of a sentence.
