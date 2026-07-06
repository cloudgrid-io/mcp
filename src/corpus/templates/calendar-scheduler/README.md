# calendar-scheduler template — calendar / scheduling app blueprint

A blueprint for a calendar scheduler on CloudGrid: a persistent Next.js + Mongo
app whose domain is events and availability (`events`, `availability`, optional
`bookings`) — create events on a calendar, define bookable slots, handle
timezones and recurrence, and (once platform issue #1543 ships) fire scheduled
reminders from a `cron` service. Because a real scheduler involves choices (auth
or single-user, paid bookings or not, which date library), this template ships
the **structure and `cloudgrid.yaml`, not finished app code** — you adapt it and build.

> **This is a blueprint: structure + cloudgrid.yaml, adapt and build.** Read
> `AGENTS.md` for the file tree, Mongo collections, CloudGrid injection table
> (needs + optional vault), the optional auth/payments layers, the intended cron
> reminder shape (BLOCKED on #1543), and the deploy flow — then generate the app
> under `services/web/` and `grid plug` it (runtime, local edition, async — poll
> to a live URL).

## Files

- `cloudgrid.yaml` — active fields: `name`, `services.web` (nextjs, `/`),
  `needs: { database: true }`. Includes a COMMENTED cron `reminders` service
  (intended shape; not yet deployable — platform issue #1543) and a commented
  `vault:` block for optional auth / payments / reminder-provider secrets.
- `AGENTS.md` — the structure guide (read this first).
- `index.md` — the fetch-bundle summary + cloudgrid.yaml.
