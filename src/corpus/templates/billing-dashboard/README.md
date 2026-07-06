# billing-dashboard template — SaaS billing blueprint (Next.js + Mongo + Stripe)

A **blueprint** for a real SaaS billing dashboard on CloudGrid: a Next.js app that
tracks `customers`, `invoices`, `charges`, and `usage_events` in the grid-shared
Mongo, meters usage, renders a revenue view (MRR / outstanding / recent invoices),
and wires **Stripe** the CloudGrid-correct way — checkout to collect invoices and a
signature-verified webhook that marks them paid and records charges. It is the same
proven `services/web/` + lazy-Mongo shape as `app-with-data`, plus payments. It
exists because "build a billing / invoicing dashboard" needs a database *and* a
payment provider wired correctly (Mongo via `needs`, the Stripe key via the
`vault:` block → `STRIPE_KEY`), and getting that wiring right is the hard part.

**This is a blueprint: structure + `cloudgrid.yaml`, adapt and build — not finished
app code.** Read `AGENTS.md` for the file tree, the Mongo collections/fields, how
the grid injects Mongo (`DATABASE_MONGODB_URL`) and the Stripe secret (`vault:` →
`STRIPE_KEY`), the checkout + webhook + usage wiring, and the deploy steps — then
build the app under `services/web/`, adapting the collections and UI to the user's
billing model.
