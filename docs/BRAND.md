# Brand

The `claude-code-driver` identity is a **terminal tile**: a dark rounded square with window dots, a teal prompt
chevron and a cursor. It says "this drives a terminal program" at a glance and stays legible at 16 px.

The project is independent and **not affiliated with Anthropic**. Do not combine this mark with Anthropic or Claude
logos, and do not use Anthropic's brand colors as the primary palette.

## Assets

| Asset | File | Use |
|---|---|---|
| Mark | [`docs/assets/brand/mark.svg`](assets/brand/mark.svg) · [`mark-512.png`](assets/brand/mark-512.png) | avatars, nav logo, anywhere square |
| Wordmark | [`docs/assets/brand/wordmark.svg`](assets/brand/wordmark.svg) | headers on light or dark backgrounds |
| Favicon | [`docs/assets/brand/favicon.svg`](assets/brand/favicon.svg) · [`favicon-32.png`](assets/brand/favicon-32.png) · [`apple-touch-icon.png`](assets/brand/apple-touch-icon.png) | browsers and home screens; a simplified mark without window dots |
| Open Graph card | [`docs/assets/brand/og-image.png`](assets/brand/og-image.png) (1200×630, source `og-image.svg`) | link previews (site `og:image`, `twitter:image`) |
| GitHub social preview | [`docs/assets/brand/social-preview.png`](assets/brand/social-preview.png) (1280×640, source `social-preview.svg`) | repository *Settings → Social preview* |
| README banner | [`docs/assets/banner.svg`](assets/banner.svg) | top of the README |
| Diagrams | [`docs/assets/layers.svg`](assets/layers.svg) · [`channels.svg`](assets/channels.svg) · [`step-cycle.svg`](assets/step-cycle.svg) · [`hero.svg`](assets/hero.svg) | docs and the site |

![Mark](assets/brand/mark.svg)

SVGs are the source of truth. After editing one, regenerate the PNGs with `pnpm brand:render` (headless Chrome; set
`CHROME=/path/to/chrome` if it is not in a standard location).

## Color

| Role | Hex | Notes |
|---|---|---|
| Ink | `#0B1220` | tile, dark backgrounds |
| Panel | `#111A2E` | cards on ink |
| Line | `#24324D` | borders, rules |
| **Signal teal** | `#2DD4BF` | primary accent; gradient `#5EEAD4 → #14B8A6` |
| Teal (light theme) | `#0F766E` | links and buttons on white (≈5.4:1, WCAG AA) |
| Text | `#E6EDF7` | primary text on ink |
| Muted | `#8B9BB4` | secondary text on ink |
| Sky | `#60A5FA` | channel: transcript |
| Amber | `#FBBF24` | channel: network |
| Rose | `#FB7185` | channel: screen |
| Violet | `#A78BFA` | the pure core, registry |

The four channel colors always mean the same thing in diagrams: **teal = hooks, sky = transcript, amber = network,
rose = screen**.

## Type

- **Monospace** (wordmark, code, labels): JetBrains Mono, falling back to SF Mono / Menlo / Consolas.
- **Sans** (prose): Inter, falling back to the system UI font.
- The wordmark is lower-case `claude-code-driver`, with `driver` in signal teal.

## Diagrams

Diagrams are hand-written SVG with their own ink panel, so they read the same on light and dark pages and on GitHub.
Keep text at 12 px or larger at the native width (920 px), label every arrow, and use the channel colors above.
