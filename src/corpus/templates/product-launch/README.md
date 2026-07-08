# Template: product-launch (static)

A single self-contained HTML product-launch page. **No infrastructure** — no
database, no backend, no `needs:`. Everything (layout, styles, countdown) lives
in one `index.html` with inline CSS and inline JS. State (the countdown) is
computed client-side; there is nothing to persist.

## What it is

A one-page launch announcement with:

- a sticky nav + primary CTA,
- a hero with headline, subhead, launch badge, and a **product image**
  (an inline SVG placeholder — swap it for a real screenshot or photo),
- a **launch countdown** to a target date/time,
- a **key features** grid,
- a **launch offer** block (price / was-price / fine print + CTA),
- **social proof** (headline stats + testimonials),
- a footer.

## How to adapt

1. Replace the `{{PLACEHOLDER}}` tokens with the user's content (product name,
   hero copy, features, offer, quotes, footer).
2. Set the countdown target: replace `{{LAUNCH_DATETIME_ISO}}` with an ISO 8601
   instant like `2026-09-01T09:00:00Z`. If it is left unset or invalid, the
   timer falls back to 14 days from load.
3. Swap the hero product image: replace the inline `<svg>` in `.shot` with a
   real screenshot. **Keep it self-contained** — inline SVG or a `data:` URI,
   never an external URL, `<script src>`, `<link href>`, CDN, or web font.
4. Add or remove `.feature` and `.quote` blocks freely (see the
   `FEATURES_START`/`FEATURES_END` and `QUOTES_START`/`QUOTES_END` markers).

## How it deploys

Deploys as an **inspiration** — instant, and works on the **hosted** edition
(Claude Web) as well as local. Use **`grid_plug`** with the inline `html`: you get a live share URL right away. Re-dropping the same entity
updates the same URL, so the user iterates on one link.

The reference `cloudgrid.yaml` in this directory (`type: static`) is ONLY for
plugging the page as an OWNED static runtime (async, local edition only); the
fast path is `grid_plug`.

The fillable HTML is the real template — fetch it with
`grid_fetch("template", "product-launch")` and fill in the user's content.
