# Example: crm — "Sales Pipeline CRM"

A filled reference imitating the `crm` template: a persistent sales-pipeline CRM.
Same stack (Next.js App Router + the `mongodb` driver, grid-shared Mongo via
`process.env.DATABASE_MONGODB_URL`). Contacts have a `name`, `email`, `company`,
a `stage` (lead / qualified / customer) and a `note`; the table lets you add a
contact, change its stage inline, and delete it.

Data persists in the grid-shared Mongo, so the whole team sees the same pipeline
across sessions and refresh.

**Same three proven rules as the template:** (1) app code lives under
**`services/web/`** (the service name, NOT the repo root — `path:` is the URL
mount); (2) the DB connection string is read **lazily inside the `getDb`
getter**, never at module top level (a top-level read fails `next build`); (3)
the datastore is declared with the canonical **`needs: { database: true }`** —
the deployer provisions Mongo and injects `DATABASE_MONGODB_URL` (plus the legacy
`MONGODB_URL` alias). Don't use the deprecated `requires:` alias.

## cloudgrid.yaml

```yaml
# `needs: { database: true }` is canonical: the deployer provisions Mongo and
# injects DATABASE_MONGODB_URL (plus the legacy MONGODB_URL alias). `requires:`
# is the deprecated v1 alias — don't mix the two (the validator rejects it).
name: sales-pipeline-crm
services:
  web:
    type: nextjs
    path: /
needs:
  database: true
```

## services/web/package.json

```json
{
  "name": "sales-pipeline-crm",
  "version": "0.1.0",
  "private": true,
  "scripts": { "dev": "next dev", "build": "next build", "start": "next start" },
  "dependencies": {
    "next": "^15.1.0",
    "react": "^19.0.0",
    "react-dom": "^19.0.0",
    "mongodb": "^6.12.0"
  }
}
```

## services/web/lib/db.js

```js
// Cached Mongo client. The grid injects DATABASE_MONGODB_URL (plus the legacy
// MONGODB_URL alias) at dev + runtime. Read the canonical var first, fall back to
// the legacy alias. Resolve it LAZILY inside the getter — a top-level read fails
// `next build`.
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

## services/web/app/api/contacts/route.js

```js
import { NextResponse } from "next/server";
import { ObjectId } from "mongodb";
import { getDb } from "../../../lib/db.js";

export const dynamic = "force-dynamic";

const STAGES = ["lead", "qualified", "customer"];

async function contacts() {
  return (await getDb()).collection("contacts");
}

function shape(c) {
  return {
    id: c._id.toString(),
    name: c.name || "",
    email: c.email || "",
    company: c.company || "",
    stage: STAGES.includes(c.stage) ? c.stage : "lead",
    note: c.note || "",
  };
}

// GET /api/contacts — list the pipeline.
export async function GET() {
  const col = await contacts();
  const items = await col.find({}).sort({ createdAt: -1 }).toArray();
  return NextResponse.json(items.map(shape));
}

// POST /api/contacts — add a contact. Body: { name, email, company, note }.
export async function POST(request) {
  const body = await request.json().catch(() => ({}));
  const name = typeof body.name === "string" ? body.name.trim() : "";
  if (!name) return NextResponse.json({ error: "name is required" }, { status: 400 });
  const doc = {
    name,
    email: typeof body.email === "string" ? body.email.trim() : "",
    company: typeof body.company === "string" ? body.company.trim() : "",
    stage: "lead",
    note: typeof body.note === "string" ? body.note.trim() : "",
    createdAt: new Date(),
  };
  const col = await contacts();
  const res = await col.insertOne(doc);
  return NextResponse.json({ id: res.insertedId.toString(), ...doc }, { status: 201 });
}

// PATCH /api/contacts — move a contact along the pipeline. Body: { id, stage }.
export async function PATCH(request) {
  const body = await request.json().catch(() => ({}));
  const { id, stage } = body;
  if (!id || !ObjectId.isValid(id) || !STAGES.includes(stage)) {
    return NextResponse.json({ error: "valid id and stage required" }, { status: 400 });
  }
  const col = await contacts();
  await col.updateOne({ _id: new ObjectId(id) }, { $set: { stage } });
  return NextResponse.json({ ok: true });
}

// DELETE /api/contacts?id=<id>
export async function DELETE(request) {
  const id = new URL(request.url).searchParams.get("id");
  if (!id || !ObjectId.isValid(id)) {
    return NextResponse.json({ error: "valid id is required" }, { status: 400 });
  }
  const col = await contacts();
  await col.deleteOne({ _id: new ObjectId(id) });
  return NextResponse.json({ ok: true });
}
```

## services/web/app/page.js

```js
import { getDb } from "../lib/db.js";
import ContactManager from "./contact-manager.js";

export const dynamic = "force-dynamic";

const STAGES = ["lead", "qualified", "customer"];

async function listContacts() {
  const items = await (await getDb())
    .collection("contacts")
    .find({})
    .sort({ createdAt: -1 })
    .toArray();
  return items.map((c) => ({
    id: c._id.toString(),
    name: c.name || "",
    email: c.email || "",
    company: c.company || "",
    stage: STAGES.includes(c.stage) ? c.stage : "lead",
    note: c.note || "",
  }));
}

export default async function Page() {
  const contacts = await listContacts();
  return (
    <main>
      <h1>Sales Pipeline</h1>
      <p className="hint">Shared across the team — persisted in grid Mongo.</p>
      <ContactManager initialContacts={contacts} />
    </main>
  );
}
```

## services/web/app/contact-manager.js

```js
"use client";
import { useState } from "react";

const STAGES = ["lead", "qualified", "customer"];
const LABELS = { lead: "Lead", qualified: "Qualified", customer: "Customer" };

export default function ContactManager({ initialContacts }) {
  const [contacts, setContacts] = useState(initialContacts);
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [company, setCompany] = useState("");

  async function add(e) {
    e.preventDefault();
    if (!name.trim()) return;
    const res = await fetch("/api/contacts", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name, email, company }),
    });
    if (res.ok) { setContacts((p) => [await res.json(), ...p]); setName(""); setEmail(""); setCompany(""); }
  }

  async function setStage(id, stage) {
    const res = await fetch("/api/contacts", {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ id, stage }),
    });
    if (res.ok) setContacts((p) => p.map((c) => (c.id === id ? { ...c, stage } : c)));
  }

  async function remove(id) {
    const res = await fetch(`/api/contacts?id=${encodeURIComponent(id)}`, { method: "DELETE" });
    if (res.ok) setContacts((p) => p.filter((c) => c.id !== id));
  }

  return (
    <div>
      <form onSubmit={add} className="row">
        <input value={name} onChange={(e) => setName(e.target.value)} placeholder="Name" />
        <input value={email} onChange={(e) => setEmail(e.target.value)} placeholder="Email" />
        <input value={company} onChange={(e) => setCompany(e.target.value)} placeholder="Company" />
        <button type="submit">Add</button>
      </form>
      <table>
        <thead>
          <tr><th>Name</th><th>Email</th><th>Company</th><th>Stage</th><th></th></tr>
        </thead>
        <tbody>
          {contacts.map((c) => (
            <tr key={c.id}>
              <td>{c.name}</td>
              <td>{c.email}</td>
              <td>{c.company}</td>
              <td>
                <select value={c.stage} onChange={(e) => setStage(c.id, e.target.value)}>
                  {STAGES.map((s) => <option key={s} value={s}>{LABELS[s]}</option>)}
                </select>
              </td>
              <td><button type="button" onClick={() => remove(c.id)}>Delete</button></td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
```

## Notes

- Deploy the same way as the template: `grid dev` locally, `grid plug` to deploy
  (async — poll status to a live URL). Re-plug the same entity to keep one URL.
- The only store this needs is Mongo (`needs: { database: true }`). Add
  `cache: true` to `needs:` only for caching/sessions you actually use.
- All app code lives under `services/web/`; the connection is read lazily inside
  `getDb`, never at module top level.
