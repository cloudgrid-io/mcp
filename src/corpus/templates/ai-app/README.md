# ai-app template — AI chatbot on Next.js + the grid AI gateway + Mongo

A minimal but real, deployable AI chatbot. A Next.js App Router app that calls
the grid AI gateway (via `@cloudgrid-io/ai`) for replies and persists the
conversation to the grid-shared MongoDB, so history survives refresh and is
shared across sessions.

## How the grid gives you AI + a database

You do **not** set an API key or provision a database. In `cloudgrid.yaml` you
declare `needs: { ai: true, database: true }`, and the grid:

- wires the **AI gateway** with the app's in-grid identity — `@cloudgrid-io/ai`
  `createClient()` auto-detects it, so there is **no API key to set**; and
- provisions shared Mongo and injects the connection string as the
  **`DATABASE_MONGODB_URL`** environment variable (plus the legacy `MONGODB_URL`
  alias) — at dev-time (`grid dev`) and at runtime (after `grid plug`).

### The AI call

```js
import { createClient } from "@cloudgrid-io/ai";
const client = createClient();                       // zero-arg, no key
const r = await client.chat({ messages: [{ role: "user", content: text }] });
const reply = r.text ?? r.content;                   // reply text
```

`createClient()` takes no key — it uses the in-grid identity, so it only works
inside a deployed grid app (or under `grid dev`). Do **not** pass or set an API
key.

### The database

The app reads `process.env.DATABASE_MONGODB_URL` (with a legacy
`process.env.MONGODB_URL` fallback) inside `getDb` in
`services/web/lib/db.js` — **lazily, never at module top level** (a top-level
read fails `next build`, which imports the module for route analysis before the
grid injects the var). Never hardcode a connection string; never commit a secret.

> **Declare `needs: { ai: true, database: true }` (the canonical shape).** The
> deployer wires the AI gateway and provisions Mongo, injecting
> `DATABASE_MONGODB_URL` (plus the legacy `MONGODB_URL` alias). `requires:` is
> the deprecated v1 alias — don't author new yaml with it, and never set `needs:`
> and `requires:` together (the validator rejects the combination).

## Service layout

App code lives under **`services/web/`**, not the template root. `path:` in
`cloudgrid.yaml` is the URL mount, not the filesystem path — the service named
`web` means the CLI looks for `services/web/`. Files at the root fail with
`Error: Service directory not found: …/services/web`.

## Run locally

```bash
cd services/web && npm install && cd -
grid dev          # runs Next.js with the AI gateway + DATABASE_MONGODB_URL wired
```

## Deploy

```bash
grid plug         # builds + deploys the folder (async — poll status until live)
```

A runtime deploy is asynchronous: `plug` returns `status: building`; poll status
until the app is live, then use the returned live URL. Re-plug the same entity to
update the same URL.

## File tree

```
cloudgrid.yaml                        # name + services.web (nextjs) + needs: { ai: true, database: true }
services/web/package.json             # next, react, react-dom, @cloudgrid-io/ai, mongodb
services/web/lib/db.js                # lazy Mongo client from DATABASE_MONGODB_URL (legacy MONGODB_URL fallback)
services/web/app/layout.js            # root layout + inline CSS
services/web/app/page.js              # server component: reads chat history from Mongo
services/web/app/chat.js              # client component: sends messages, renders the log
services/web/app/api/chat/route.js    # POST: createClient().chat(...) -> persist -> reply; GET: history
```

## Adapt it

- Give the assistant a persona — pass a `{ role: "system", content: "…" }`
  message ahead of the user message in the `chat({ messages })` call.
- Send prior turns as context by including the stored history in `messages`.
- Change the `messages` collection / fields; add users, sessions, titles.
- Restyle the chat UI in `layout.js` / `chat.js`.

## RAG / retrieval (not included)

To answer over **your own documents** (retrieval-augmented generation) you need a
vector store — `needs: { vector: pgvector }`. That need is **now available** —
#1545 shipped (verified live 2026-07-16) — but this template is a plain chatbot:
declare the need and build the retrieval code on top if you want RAG.
