# forum template — threaded community forum (BLUEPRINT)

A community discussion board where members sign in to start threads and post
nested replies, with moderation — a persistent Next.js app under `services/web/`
backed by grid-shared MongoDB (`threads` / `posts` / `users`), with sign-in-to-post
auth via a hosted provider (Clerk / Auth0) whose keys come from the org vault.
This is a **blueprint**: it ships the structure and the `cloudgrid.yaml`, not
runnable app code — read `AGENTS.md` for the file tree, Mongo schema, CloudGrid
wiring (DATABASE_MONGODB_URL, vault→env secrets), auth/moderation, and the
`write files → grid plug → poll` deploy flow (the first plug auto-creates the
entity from `cloudgrid.yaml`), then adapt and build the app.

See `AGENTS.md` for the full structure guide.
