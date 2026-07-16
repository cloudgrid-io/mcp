# Example: ai-app — "Trip Planner Bot"

A filled reference imitating the `ai-app` template: a themed AI assistant — a
travel trip planner. Same stack (Next.js App Router + `@cloudgrid-io/ai` for the
grid AI gateway + the `mongodb` driver for chat history), slightly richer than
the bare chatbot: it gives the assistant a **persona** via a `system` message and
sends the **prior conversation** as context, so replies stay on-theme and
coherent across turns.

Data persists in the grid-shared Mongo, so the conversation survives refresh.

**Same four proven rules as the template:** (1) app code lives under
**`services/web/`** (the service name, NOT the repo root — `path:` is the URL
mount); (2) the AI call is **zero-config — `createClient()` with no key** (it
uses the in-grid identity); (3) the DB connection string is read **lazily inside
the `getDb` getter**, never at module top level (a top-level read fails `next
build`); (4) the datastore is declared with the canonical **`needs: { ai: true,
database: true }`**. Don't use the deprecated `requires:` alias.

## cloudgrid.yaml

```yaml
# `needs: { ai: true, database: true }` is canonical: the deployer wires the AI
# gateway (in-grid identity — no key) and provisions Mongo, injecting
# DATABASE_MONGODB_URL (plus the legacy MONGODB_URL alias). `requires:` is the
# deprecated v1 alias — don't mix the two (the validator rejects it).
name: trip-planner-bot
services:
  web:
    type: nextjs
    path: /
needs:
  ai: true
  database: true
# RAG over your own docs needs `needs: { vector: pgvector }` — available now,
# #1545 shipped (verified live 2026-07-16). This example does not use it.
```

## services/web/package.json

```json
{
  "name": "trip-planner-bot",
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
// Trip-planner chat route: give the assistant a persona, send the prior
// conversation as context, ask the grid AI gateway, persist the exchange,
// return the reply. Zero-config AI — createClient() with no key uses the in-grid
// identity.
import { NextResponse } from "next/server";
import { createClient } from "@cloudgrid-io/ai";
import { getDb } from "../../../lib/db.js";

export const dynamic = "force-dynamic";

const SYSTEM = {
  role: "system",
  content:
    "You are Trip Planner Bot, a concise, friendly travel assistant. Suggest " +
    "itineraries, budgets, and practical tips. Ask a clarifying question when the " +
    "destination or dates are unclear.",
};

async function messages() {
  return (await getDb()).collection("messages");
}

export async function POST(request) {
  const body = await request.json().catch(() => ({}));
  const text = typeof body.message === "string" ? body.message.trim() : "";
  if (!text) return NextResponse.json({ error: "message is required" }, { status: 400 });

  const col = await messages();

  // Load recent history for context (last 20 turns), oldest first.
  const prior = await col.find({}).sort({ createdAt: -1 }).limit(20).toArray();
  prior.reverse();
  const context = prior.map((m) => ({ role: m.role, content: m.content }));

  // Ask the grid AI gateway: persona + prior turns + the new user message.
  const client = createClient();
  const r = await client.chat({
    messages: [SYSTEM, ...context, { role: "user", content: text }],
  });
  const reply = r.text ?? r.content ?? "";

  // Persist the exchange.
  const now = new Date();
  await col.insertMany([
    { role: "user", content: text, createdAt: now },
    { role: "assistant", content: reply, createdAt: new Date(now.getTime() + 1) },
  ]);

  return NextResponse.json({ reply });
}

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
      <h1>Trip Planner Bot</h1>
      <p className="hint">Ask about a destination — powered by the grid AI gateway, saved to Mongo.</p>
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
        {history.length === 0 && <li className="empty">Where do you want to go?</li>}
        {history.map((m) => (
          <li key={m.id} className={m.role}>
            <span className="who">{m.role === "user" ? "You" : "Trip Planner"}</span>
            <span className="msg">{m.content}</span>
          </li>
        ))}
      </ul>
      <form onSubmit={send} className="row">
        <input value={text} onChange={(e) => setText(e.target.value)} placeholder="e.g. 4 days in Lisbon on a budget" disabled={busy} />
        <button type="submit" disabled={busy}>{busy ? "…" : "Send"}</button>
      </form>
    </div>
  );
}
```

## Notes

- Deploy the same way as the template: `grid dev` locally, `grid plug` to deploy
  (async — poll status to a live URL). Re-plug the same entity to keep one URL.
- The needs are Mongo + the AI gateway (`needs: { ai: true, database: true }`).
  The AI call is zero-config — `createClient()` with no key uses the in-grid
  identity.
- All app code lives under `services/web/`; the connection is read lazily inside
  `getDb`, never at module top level.
- To answer over your own documents (RAG) you'd add `needs: { vector: pgvector }`
  — available now (#1545 shipped); this example ships without it, so you'd also
  write the retrieval code.
