# Site assets — Higgsfield artwork (ticket 10)

All artwork generated 2026-07-28 via the `higgsfield` CLI, model **GPT Image 2**
(`gpt_image_2`, backend model `videotape-alpha`), account marino.chris@me.com.
Two generation jobs total; post-processing done locally with Pillow 12.2
(Lanczos resampling).

## Files

| File | Purpose | Source |
|---|---|---|
| `hero-1920.webp` | Hero, large (1920×1075, upscaled from 1344×752 native) | hero job |
| `hero-960.webp` | Hero, small (960×537) | hero job |
| `og-card.jpg` | OG/social card 1200×630 (progressive JPEG, q85) | crop of hero |
| `og-card.webp` | OG/social card 1200×630 (webp, q82) | crop of hero |
| `favicon-512.png` | Icon / PWA size | mark job |
| `favicon-180.png` | Apple touch icon size | mark job |
| `favicon-32.png` | Browser favicon | mark job |

## Job 1 — Hero

- Job ID: `0170f681-c0fe-400d-9b44-b448e9bdf8dc`
- Params: `--aspect_ratio 16:9 --resolution 1k --quality medium` → 1344×752 PNG
- Cost: 2 credits
- Prompt:

> Abstract civic-ledger fine-art composition, wide editorial hero image. Pale
> marble and limestone architectural forms suggesting a neoclassical colonnade,
> rendered as calm flat planes and rhythmic vertical columns, dissolving into
> finely engraved horizontal ledger-line rulings, like an antique stone
> accounting ledger. One single thin accent thread of warm ochre color #D97E1E
> weaves continuously through the columns and along the ledger lines — the only
> saturated color in the image. Warm paper tones (#F7F5F0, ivory, cream)
> dominate; soft muted ink-gray shadows; quiet open negative space left of
> center. Flat matte engraved-print aesthetic, restrained editorial minimalism,
> archival intaglio texture. Strictly no text, no letters, no numbers, no
> people, no faces, no figures, no logos, no seals, no emblems, no flags.

## Job 2 — Favicon mark

- Job ID: `f581fc92-a919-4392-8424-43ba75007d7d`
- Params: `--aspect_ratio 1:1 --resolution 1k --quality low` → 1024×1024 PNG
- Cost: 0.5 credits
- Prompt:

> Minimal flat geometric logo mark centered on a solid warm-paper background of
> color #F7F5F0, generous even margins. The mark: a compact stack of thin
> horizontal ledger-grid rules on the left that merges seamlessly into one bold
> abstract geometric monogram suggesting the Bitcoin currency symbol — a strong
> vertical stem with two rounded right-side bowls, built purely from clean
> straight lines and simple arcs, abstract and iconic. Exactly two ink colors
> on the paper background: deep warm charcoal ink for the ledger rules and
> stem, warm ochre #D97E1E for the rounded bowls. Flat solid vector style,
> uniform thick strokes, crisp sharp edges, high contrast, instantly legible
> when shrunk to a 32 pixel favicon. No gradients, no shadows, no 3D, no
> texture, no words, no letters, no numbers, no extra symbols, nothing else in
> the frame.

## Crop / derivation recipes

- **OG card (1200×630)** — center-weighted crop of the hero, no separate
  generation. From the native 1344×752 hero: keep the full 1344px width (this
  preserves the quiet negative space left of center for title overlay), crop a
  vertically centered 1344×706 band starting at y=23 (706 = round(1344 ÷
  (1200/630))), then Lanczos-resize to 1200×630. Saved as progressive JPEG q85
  and webp q82.
- **Hero webp** — native 1344×752 PNG Lanczos-resized to 1920×1075 (mild 1.43×
  upscale; the flat engraved style tolerates it cleanly) and 960×537, webp q82,
  method 6.
- **Favicons** — auto-detected the mark's bounding box on the 1024×1024 source
  (non-background pixels, tolerance 48), found bbox (314,278)–(720,726), padded
  14% per side, and cropped the centered 574×574 square at (230,215). That
  square was Lanczos-resized to 512, 180, and 32 px PNGs (solid warm-paper
  background retained).

## Budget

Account started at 3 credits; 2.5 consumed (2 + 0.5); **0.5 credits remain**.
