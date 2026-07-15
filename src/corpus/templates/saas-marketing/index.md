# Template: saas-marketing (static)

A single self-contained HTML SaaS marketing site (hero, features, pricing tiers, testimonials, FAQ, and a closing call to action). Richer than the landing-page template. **No infrastructure** — no database, no backend, no `needs:`.
State (if any) lives only in memory and is lost on refresh.

## How it deploys

To publish this page, use **`grid_deploy`** with the inline `html`: it deploys as an **inspiration** — instant, and works on the **hosted**
edition (Claude Web) as well as local. The reference `cloudgrid.yaml` in this
directory (`type: static`) is ONLY for plugging the page as an OWNED static
runtime (async, local edition only); the fast path is `grid_deploy`.

The fillable HTML is the real template — fetch it with
`grid_get_template("template", "saas-marketing")` and fill in the user's content.

## cloudgrid.yaml (reference only)

```yaml
# On disk this file is the full-annotated reference (templates/_cloudgrid.yaml.reference) with EVERY
# field present as a comment; only the fields below are uncommented, so it
# deploys to exactly these active fields.
name: saas-marketing
services:
  web:
    type: static
    path: /
```
