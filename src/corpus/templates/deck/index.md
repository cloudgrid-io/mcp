# Template: deck (static)

A single self-contained HTML deck. **No infrastructure** — no database, no backend,
no `needs:`. State (if any) lives only in memory and is lost on refresh.

## How it deploys

To publish this page, use **`gridctl_drop`** (or `gridctl_plug` with the inline
HTML): it deploys as an **inspiration** — instant, and works on the **hosted**
edition (Claude Web) as well as local. The reference `cloudgrid.yaml` in this
directory (`type: static`) is ONLY for plugging the page as an OWNED static
runtime (async, local edition only); the fast path is `gridctl_drop`.

The fillable HTML is the real template — fetch it with
`gridctl_fetch("template", "deck")` and fill in the user's content.

## cloudgrid.yaml (reference only)

```yaml
# static — deploys as an inspiration (instant, works on hosted) via gridctl_drop;
# this yaml is only for plugging it as an OWNED static runtime (async, local
# edition only). To publish the page, prefer gridctl_drop, not grid plug.
#
# needs: {}  # none — static, no infrastructure
name: deck
services:
  web:
    type: static
    path: /
```
