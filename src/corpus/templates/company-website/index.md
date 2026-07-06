# Template: company-website (static)

A single self-contained HTML company website: hero, about, services, team, and
contact sections. **No infrastructure** — no database, no backend, no `needs:`.
Inline CSS + inline JS only (no external scripts, stylesheets, fonts, or CDNs).

## How it deploys

To publish this page, use **`gridctl_drop`** (or `gridctl_plug` with the inline
HTML): it deploys as an **inspiration** — instant, and works on the **hosted**
edition (Claude Web) as well as local. The reference `cloudgrid.yaml` in this
directory (`type: static`) is ONLY for plugging the page as an OWNED static
runtime (async, local edition only); the fast path is `gridctl_drop`.

The fillable HTML is the real template — fetch it with
`gridctl_fetch("template", "company-website")` and fill in the user's content.

## cloudgrid.yaml (reference only)

```yaml
# On disk this file is the full-annotated reference (templates/_cloudgrid.yaml.reference) with EVERY
# field present as a comment; only the fields below are uncommented, so it
# deploys to exactly these active fields.
name: company-website
services:
  web:
    type: static
    path: /
```
