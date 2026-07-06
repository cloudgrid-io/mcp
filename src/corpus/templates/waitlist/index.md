# Template: waitlist (static)

A single self-contained HTML launch waitlist / coming-soon page: a hero, an email capture form, and a social-proof counter. **No infrastructure** — no database, no backend, no `needs:`.
State (if any) lives only in memory and is lost on refresh.

## How it deploys

To publish this page, use **`gridctl_drop`** (or `gridctl_plug` with the inline
HTML): it deploys as an **inspiration** — instant, and works on the **hosted**
edition (Claude Web) as well as local. The reference `cloudgrid.yaml` in this
directory (`type: static`) is ONLY for plugging the page as an OWNED static
runtime (async, local edition only); the fast path is `gridctl_drop`.

The fillable HTML is the real template — fetch it with
`gridctl_fetch("template", "waitlist")` and fill in the user's content.

## Note on storing signups

The signup form here is **static**. It posts to a configurable action — a
`mailto:` (the default) or an external form endpoint you set on the `<form>`.
It does NOT store submissions anywhere on CloudGrid.

To actually **store** waitlist signups (persist them, count them, export them),
you need a runtime app with a database — `needs: { database: true }`. That is a
CRUD app, coming in the crud-app archetype (Wave 1b). Do not pretend this static
page persists data.

## cloudgrid.yaml (reference only)

```yaml
# On disk this file is the full-annotated reference (templates/_cloudgrid.yaml.reference) with EVERY
# field present as a comment; only the fields below are uncommented, so it
# deploys to exactly these active fields.
name: waitlist
services:
  web:
    type: static
    path: /
```
