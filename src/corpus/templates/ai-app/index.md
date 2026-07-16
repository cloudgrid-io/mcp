# Template: ai-app (Next.js AI chatbot + grid AI gateway + Mongo)

A minimal but real, deployable AI chatbot. A Next.js App Router app that calls
the grid AI gateway (via `@cloudgrid-io/ai`) for replies and persists the
conversation to the grid-shared MongoDB. History survives refresh and is shared
across sessions.

**Key rules (all proven by a real end-to-end deploy):**

1. **App code MUST live under `services/<name>/`, not the repo/template root.**
   `path:` in `cloudgrid.yaml` is the URL mount, NOT the filesystem path. The
   service named `web` → the CLI looks for `services/web/`. Files at the root
   fail with `Error: Service directory not found: …/services/web`.
2. **The AI call is zero-config — no API key.** `import { createClient } from
   "@cloudgrid-io/ai"; const client = createClient();` auto-detects the in-grid
   identity, so it only works inside a deployed grid app (or under `grid dev`).
   Do NOT pass or set an API key. Read the reply from `r.text` (fall back to
   `r.content`).
3. **Read the DB connection string LAZILY (inside the getter), never at module
   top level.** The grid injects it as `DATABASE_MONGODB_URL` (plus the legacy
   `MONGODB_URL` alias) at dev + runtime; the app reads
   `process.env.DATABASE_MONGODB_URL || process.env.MONGODB_URL` inside `getDb`.
   A top-level read fails `next build`. Never hardcode a connection string; never
   commit a secret.
4. **Declare `needs: { ai: true, database: true }`.** The deployer wires the AI
   gateway and provisions Mongo (injecting `DATABASE_MONGODB_URL` + legacy
   `MONGODB_URL`). `requires:` is the deprecated v1 alias; don't author new yaml
   with it, and never set `needs:` and `requires:` together (the validator
   rejects the combination).

Write these files into the scaffolded app folder — the app code goes under
`services/web/` — adapt the persona/UI, then `grid dev` (local) / `grid plug`
(deploy, async — poll to a live URL).

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

## cloudgrid.yaml

```yaml
# On disk this file is the full-annotated reference (templates/_cloudgrid.yaml.reference) with EVERY
# field present as a comment; only the fields below are uncommented, so it
# deploys to exactly these active fields.
name: my-chatbot
services:
  web:
    type: nextjs
    path: /
needs:
  ai: true
  database: true
```

> **Capability:** this template's needs are `ai: true` (the grid AI gateway,
> in-grid identity — no key) and `database: true` (Mongo, injected as
> `DATABASE_MONGODB_URL` + legacy `MONGODB_URL`). `requires:` is the deprecated
> v1 alias — don't mix it with `needs:`. See the capability-map for the full
> injection table.

## services/web/package.json

```json
{
  "name": "my-chatbot",
  "version": "0.1.0",
  "private": true,
  "scripts": { "dev": "next dev", "build": "next build", "start": "next start" },
  "dependencies": {
    "next": "^15.1.0",
    "react": "^19.0.0",
    "react-dom": "^19.0.0",
    "@cloudgrid-io/ai": "^0.2.0",
    "mongodb": "^6.12.0"
  }
}
```

## services/web/lib/db.js

```js
// Cached Mongo client for the chat history. The grid injects DATABASE_MONGODB_URL
// (plus the legacy MONGODB_URL alias) at dev + runtime. Resolve it LAZILY inside
// the getter — a top-level read fails `next build`. Never hardcode a connection
// string; never commit a secret.
import { MongoClient } from "mongodb";

function clientPromise() {
  const uri = process.env.DATABASE_MONGODB_URL || process.env.MONGODB_URL;
  if (!uri) {
    throw new Error(
      "DATABASE_MONGODB_URL is not set. The grid injects it — run `grid dev` " +
        "locally or deploy with `grid plug`. Do not set it by hand.",
    );
  }
  if (!globalThis.__mongoClientPromise) {
    globalThis.__mongoClientPromise = new MongoClient(uri).connect();
  }
  return globalThis.__mongoClientPromise;
}

export async function getDb() {
  return (await clientPromise()).db();
}
```

## services/web/app/api/chat/route.js

```js
// Chat API route: take the user's message, ask the grid AI gateway for a reply,
// persist the exchange to Mongo, return the reply.
//
// The AI call uses @cloudgrid-io/ai with ZERO config — no API key. createClient()
// auto-detects the in-grid identity, so it only works inside a deployed grid app
// (or under `grid dev`). Do NOT pass a key.
import { NextResponse } from "next/server";
import { createClient } from "@cloudgrid-io/ai";
import { getDb } from "../../../lib/db.js";

export const dynamic = "force-dynamic";

async function messages() {
  return (await getDb()).collection("messages");
}

// POST /api/chat — body { message: string }. Returns { reply: string }.
export async function POST(request) {
  const body = await request.json().catch(() => ({}));
  const text = typeof body.message === "string" ? body.message.trim() : "";
  if (!text) {
    return NextResponse.json({ error: "message is required" }, { status: 400 });
  }

  // 1. Ask the grid AI gateway (zero-config in-grid identity — no key).
  const client = createClient();
  const r = await client.chat({ messages: [{ role: "user", content: text }] });
  const reply = r.text ?? r.content ?? "";

  // 2. Persist the exchange so the conversation survives refresh.
  const col = await messages();
  const now = new Date();
  await col.insertMany([
    { role: "user", content: text, createdAt: now },
    { role: "assistant", content: reply, createdAt: new Date(now.getTime() + 1) },
  ]);

  // 3. Return the reply.
  return NextResponse.json({ reply });
}

// GET /api/chat — the stored conversation, oldest first.
export async function GET() {
  const col = await messages();
  const history = await col.find({}).sort({ createdAt: 1 }).toArray();
  return NextResponse.json(
    history.map((m) => ({ id: m._id.toString(), role: m.role, content: m.content })),
  );
}
```

## services/web/app/page.js

```js
import { getDb } from "../lib/db.js";
import Chat from "./chat.js";

export const dynamic = "force-dynamic";

async function listHistory() {
  const items = await (await getDb())
    .collection("messages")
    .find({})
    .sort({ createdAt: 1 })
    .toArray();
  return items.map((m) => ({ id: m._id.toString(), role: m.role, content: m.content }));
}

export default async function Page() {
  const history = await listHistory();
  return (
    <main>
      <h1>AI Assistant</h1>
      <p className="hint">Powered by the grid AI gateway — conversation persisted in Mongo.</p>
      <Chat initialHistory={history} />
    </main>
  );
}
```

## services/web/app/chat.js

```js
"use client";
import { useState } from "react";

export default function Chat({ initialHistory }) {
  const [history, setHistory] = useState(initialHistory);
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);

  async function send(e) {
    e.preventDefault();
    const value = text.trim();
    if (!value || busy) return;
    setBusy(true);
    setHistory((p) => [...p, { id: `local-${Date.now()}`, role: "user", content: value }]);
    setText("");
    const res = await fetch("/api/chat", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ message: value }),
    });
    if (res.ok) {
      const { reply } = await res.json();
      setHistory((p) => [...p, { id: `local-${Date.now()}-a`, role: "assistant", content: reply }]);
    }
    setBusy(false);
  }

  return (
    <div>
      <ul className="log">
        {history.length === 0 && <li className="empty">Say hello to start the conversation.</li>}
        {history.map((m) => (
          <li key={m.id} className={m.role}>
            <span className="who">{m.role === "user" ? "You" : "Assistant"}</span>
            <span className="msg">{m.content}</span>
          </li>
        ))}
      </ul>
      <form onSubmit={send} className="row">
        <input value={text} onChange={(e) => setText(e.target.value)} placeholder="Ask something…" disabled={busy} />
        <button type="submit" disabled={busy}>{busy ? "…" : "Send"}</button>
      </form>
    </div>
  );
}
```

## Adapt it

- Give the assistant a persona — pass a `{ role: "system", content: "…" }`
  message ahead of the user message in `chat({ messages })`.
- Send prior turns as context by including the stored history in `messages`.
- Change the `messages` collection / fields; add users, sessions, titles.
- Run `grid dev` to test locally, `grid plug` to deploy (async — poll to live).

## RAG / retrieval (not included)

To answer over **your own documents** (retrieval-augmented generation) you need a
vector store — `needs: { vector: pgvector }`. That need is **now available** —
#1545 shipped (verified live 2026-07-16) — but this template is a plain chatbot:
declare the need and build the retrieval code on top if you want RAG.
