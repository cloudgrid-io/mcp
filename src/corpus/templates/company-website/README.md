# Template: company-website (static)

A single self-contained HTML company website — a multi-section business site with
hero, about, services, team, and contact sections. **No infrastructure** — no
database, no backend, no `needs:`. It is one HTML file with inline CSS and inline
JS (no external scripts, stylesheets, fonts, or CDNs), so it renders anywhere.

The contact form is client-side only (validates and shows a thank-you message);
wire it to your own email service or form endpoint if you want real submissions.

## How it deploys

To publish this page, use **`grid_deploy`** with the inline `html`: it deploys as an **inspiration** — instant, and works on the **hosted**
edition (Claude Web) as well as local. The reference `cloudgrid.yaml` in this
directory (`type: static`) is ONLY for plugging the page as an OWNED static
runtime (async, local edition only); the fast path is `grid_deploy`.

The fillable HTML is the real template — fetch it with
`grid_get_template("template", "company-website")` and fill in the user's content.

## How to adapt

Replace the `{{PLACEHOLDER}}` tokens in `index.html`:

- **Identity:** `{{COMPANY_NAME}}`, `{{COMPANY_TAGLINE}}`.
- **Hero:** `{{HERO_HEADLINE}}`, `{{HERO_SUBHEAD}}`, `{{PRIMARY_CTA}}`, `{{SECONDARY_CTA}}`.
- **About:** `{{ABOUT_HEADLINE}}`, `{{ABOUT_PARA_1}}`, `{{ABOUT_PARA_2}}`, and four
  `{{STAT_n_NUM}}` / `{{STAT_n_LABEL}}` pairs.
- **Services:** `{{SERVICES_HEADLINE}}`, `{{SERVICES_SUBHEAD}}`, and one card per
  service (`{{SERVICE_n_ICON}}` is a single emoji, plus title and body). Duplicate
  a `.card` block between the `SERVICES_START` / `SERVICES_END` comments to add more.
- **Team:** `{{TEAM_HEADLINE}}`, `{{TEAM_SUBHEAD}}`, and one `.member` per person
  (`{{MEMBER_n_INITIALS}}` renders in the avatar circle, plus name, role, bio).
  Duplicate a `.member` block between `TEAM_START` / `TEAM_END` to add more.
- **Contact:** `{{CONTACT_HEADLINE}}`, `{{CONTACT_SUBHEAD}}`, `{{CONTACT_EMAIL}}`,
  `{{CONTACT_PHONE}}`, `{{CONTACT_ADDRESS}}`, `{{CONTACT_HOURS}}`.

Keep it a single self-contained HTML file — do not add external scripts,
stylesheets, fonts, or large embedded media. Recolor by editing the CSS
variables in `:root` (`--accent`, `--bg`, `--fg`, etc.).

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
