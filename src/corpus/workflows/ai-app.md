---
name: ai-app
when: chatbot, AI assistant, Q&A bot, conversational app, support bot, ask-me-anything, an app that talks to an LLM / generates text with AI. Needs AI + a database → runtime → local edition.
needs: ai, database
deploy: runtime
editions: local
capabilities_note: AI chatbot — needs ai (the grid AI gateway) + a database (Mongo) for chat history. Next.js App Router app. Uses @cloudgrid-io/ai createClient().chat() with zero-config in-grid identity auth (no API key). Runtime app, async build, local edition only. Declare `needs: { ai: true, database: true }`. (RAG over your own docs needs `needs: { vector: pgvector }` — not yet available, platform issue #1545.)
summary: Build an AI chatbot on the grid — a Next.js app that calls @cloudgrid-io/ai createClient().chat({messages}) (zero-config in-grid auth, no key) and persists the conversation to grid-shared Mongo. Edition-gate first, scaffold, put the app under services/web/, declare needs:{ai:true,database:true}, read DATABASE_MONGODB_URL lazily, deploy async, poll to a live URL.
---

# Workflow: ai-app

The user wants an app that **talks to an LLM** — a chatbot, an AI assistant, a
Q&A/support bot, an ask-me-anything. It calls the grid's AI gateway to generate
replies and **remembers the conversation** in the grid-shared Mongo. So it needs
two capabilities: `ai` (the gateway) and `database` (chat history). That makes it
a **runtime app**, not a static page.

Follow this recipe. Be honest that a runtime deploy is async and needs the local
edition.

## 1. Edition check FIRST (hard gate)

An AI chatbot is a built + deployed container. It requires the **local edition**
(Claude Desktop / Claude Code) or the CLI, because the grid must run the CLI and
folder-plug your project.

- **Hosted edition (Claude Web / hosted MCP):** you CANNOT build a runtime app —
  hosted is inline-only and can only publish static pages. Tell the user plainly:
  "An AI chatbot needs the local edition (Claude Desktop/Code) or the CloudGrid
  CLI; the hosted edition can only publish static pages." STOP the runtime path
  here.
- **Local edition:** continue.

## 2. Auth + grid

Persistent apps are owned entities.
1. Ensure signed in: `grid_login_status`; if not, `grid_login`.
2. A grid is required. Respect the grid picker: if the user has more than one
   grid, ask which to use; do not assume a target.

## 3. Scaffold

`grid_create_project` an app `<name>`. `init` creates the entity + `.cloudgrid/link.json`
and writes a `cloudgrid.yaml` with an EMPTY `services: {}`. `plug` needs a linked
directory, so run `init` FIRST.

You then do two things: (a) write the app under **`services/web/`**, and (b) fill
in `cloudgrid.yaml` to the shape below (`services.web` type `nextjs` + `needs: {
ai: true, database: true }`).

## 4. Wire the AI gateway + Mongo

1. Set `cloudgrid.yaml` to declare the `web` service and the capabilities it
   needs. **App code MUST live under `services/<name>/`** — `path:` is the URL
   mount, NOT the filesystem path. A service named `web` → the CLI looks for
   `services/web/`; files at the repo root fail with
   `Error: Service directory not found: …/services/web`.
   ```yaml
   name: my-chatbot
   services:
     web:
       type: nextjs
       path: /
   needs:
     ai: true
     database: true
   # For retrieval-augmented (RAG) over your own docs, add `needs: { vector:
   # pgvector }` once platform issue #1545 ships — not yet available.
   ```
   **Declare `needs: { ai: true, database: true }`** — the canonical shape. The
   deployer wires the AI gateway (in-grid identity) and provisions Mongo,
   injecting `DATABASE_MONGODB_URL` (plus the legacy `MONGODB_URL` alias) at
   dev-time and runtime. `requires:` is the deprecated v1 alias; don't author new
   yaml with it, and never set `needs:` and `requires:` together (the validator
   rejects it).
2. Fetch the template for the chat wiring:
   `grid_get_template("template", "ai-app")`. It is a minimal Next.js App Router chat
   app under `services/web/`: a chat page, an API route
   (`app/api/chat/route.js`, `export const dynamic = "force-dynamic"`) that reads
   the user message, calls the AI gateway, persists the exchange to Mongo, and
   returns the reply.
3. **Call the AI gateway with `@cloudgrid-io/ai`** — zero config, no API key:
   ```js
   import { createClient } from "@cloudgrid-io/ai";
   const client = createClient();                    // zero-arg, no key
   const r = await client.chat({ messages: [{ role: "user", content: text }] });
   const reply = r.text ?? r.content;                // reply text
   ```
   The SDK auto-detects the in-grid identity — **do NOT set an API key.** It only
   works inside a deployed grid app (or under `grid dev`).
4. **Persist the exchange to Mongo** — read `process.env.DATABASE_MONGODB_URL`
   (falling back to the legacy `process.env.MONGODB_URL`) **lazily inside the
   getter, never at module top level**, or `next build` fails (the module is
   imported for route analysis before the grid injects the var). Store the user
   message and the assistant reply so the conversation survives refresh. Never
   hardcode a connection string; never commit a secret.
   - (Optional) fetch `grid_get_template("example", "ai-app")` for a richer filled
     reference (a themed assistant) to imitate.

## 5. (Optional) Run locally

Mention that the user can `grid dev` to run locally — the AI gateway and Mongo
are wired in dev too — and send a test message before deploying. Don't require it.

## 6. Config

- Extra API keys / secrets (only if the app needs its own) → `grid_set_secret`.
- Non-secret config → `grid_set_env`.
- Do **NOT** set the DB connection var yourself (`DATABASE_MONGODB_URL` / legacy
  `MONGODB_URL`) and do **NOT** set an AI key — the grid injects the DB var and
  the AI SDK auto-detects the in-grid identity.

## 7. Deploy (async)

Deploy the folder with `grid_deploy`. A **runtime deploy is ASYNC**: the first
response is `status: "building"` with a `poll_url` / entity, NOT a live URL yet.
- Poll `grid_status` (or the returned poll_url) until the entity is live.
- Surface a liveness signal while it builds — never a bare silent wait.
- Only once it is live, return the deployed URL (the app URL, NOT the build/log
  link).

## 8. Return the live URL + iterate

Give the user the live chatbot URL — that is the deliverable. To iterate, re-plug
the SAME entity (`target_entity_id`) so it updates the same URL.

## Note on RAG / retrieval

If the user wants the bot to answer over **their own documents** (retrieval-
augmented generation), that needs a vector store (`needs: { vector: pgvector }`).
That path is **not yet available** — platform issue #1545. Ship the plain
chatbot now; add retrieval once the vector need is unblocked.

Keep it honest: async build, local-edition only, AI auth and DB credentials
provided by the grid.
