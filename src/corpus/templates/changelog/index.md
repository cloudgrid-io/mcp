# Template: changelog (static)

A single self-contained HTML changelog / release-notes page: reverse-chronological versioned entries, each with a date and tagged change items (added / fixed / changed / removed). **No infrastructure** — no database, no backend, no `needs:`.
State (if any) lives only in memory and is lost on refresh.

## How it deploys

To publish this page, use **`grid_drop`** (or `grid_plug` with the inline
HTML): it deploys as an **inspiration** — instant, and works on the **hosted**
edition (Claude Web) as well as local. The reference `cloudgrid.yaml` in this
directory (`type: static`) is ONLY for plugging the page as an OWNED static
runtime (async, local edition only); the fast path is `grid_drop`.

The fillable HTML is the real template — fetch it with
`grid_fetch("template", "changelog")` and fill in the user's content.

## cloudgrid.yaml (reference only)

```yaml
# On disk this file is the full-annotated reference (templates/_cloudgrid.yaml.reference) with EVERY
# field present as a comment; only the fields below are uncommented, so it
# deploys to exactly these active fields.
name: changelog
services:
  web:
    type: static
    path: /
```
