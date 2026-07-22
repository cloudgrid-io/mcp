# Template: product-launch (static)

A single self-contained HTML product-launch page — hero with product image, key
features, launch offer + CTA, a live countdown, and social proof. **No
infrastructure** — no database, no backend, no `needs:`. Everything is one
`index.html` with inline CSS and inline JS; the countdown is computed
client-side.

## How it deploys

To publish this page, use **`grid_plug`** with the inline `html`: it deploys as an **inspiration** — instant, and works on the **hosted**
edition (Claude Web) as well as local. The reference `cloudgrid.yaml` in this
directory (`type: static`) is ONLY for plugging the page as an OWNED static
runtime (async, local edition only); the fast path is `grid_plug`.

The fillable HTML is the real template — fetch it with
`grid_get_template("template", "product-launch")` and fill in the user's content
(product name, hero copy, countdown target, features, offer, quotes). Keep it a
single self-contained file: inline SVG / `data:` URIs only, no external scripts,
stylesheets, fonts, or CDNs.

## cloudgrid.yaml (reference only)

```yaml
# On disk this file is the full-annotated reference (templates/_cloudgrid.yaml.reference) with EVERY
# field present as a comment; only the fields below are uncommented, so it
# deploys to exactly these active fields.
name: product-launch
services:
  web:
    type: static
    path: /
```
