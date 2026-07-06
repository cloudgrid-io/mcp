# online-store template — e-commerce blueprint (Next.js + Mongo + Stripe)

A **blueprint** for a real online store on CloudGrid: a Next.js storefront with a
cart, Stripe Checkout, a signature-verified Stripe webhook that confirms payment,
and `products` + `orders` persisted in the grid-shared Mongo — the same proven
`services/web/` + lazy-Mongo shape as `app-with-data`, plus payments. It exists
because "sell products online" is a common ask that needs a database *and* a
payment provider wired the CloudGrid-correct way (Mongo via `needs`, the Stripe
key via the `vault:` block → `STRIPE_KEY`), and getting that wiring right is the
hard part.

**This is a blueprint: structure + `cloudgrid.yaml`, not finished app code.** Read
`AGENTS.md` for the file tree, the Mongo collections/fields, how the grid injects
Mongo (`DATABASE_MONGODB_URL`) and the Stripe secret (`vault:` → `STRIPE_KEY`), the
checkout + webhook wiring, and the deploy steps — then build the app under
`services/web/`, adapting the catalog and UI to the user's store.
