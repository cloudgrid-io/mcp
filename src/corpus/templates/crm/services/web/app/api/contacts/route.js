// App Router route handler for the `contacts` collection.
// GET -> list contacts, POST -> add a contact, PATCH -> update stage/fields,
// DELETE -> remove a contact by id.
//
// To adapt this app, rename the collection and change the fields to match your
// own data (e.g. a `companies` or `deals` collection).
import { NextResponse } from "next/server";
import { ObjectId } from "mongodb";
import { getDb } from "../../../lib/db.js";

// Never cache — always read/write live data.
export const dynamic = "force-dynamic";

const STAGES = ["lead", "qualified", "customer"];

async function contacts() {
  const db = await getDb();
  return db.collection("contacts");
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

// GET /api/contacts — list all contacts, newest first.
export async function GET() {
  const col = await contacts();
  const items = await col.find({}).sort({ createdAt: -1 }).toArray();
  return NextResponse.json(items.map(shape));
}

// POST /api/contacts — add a contact. Body: { name, email, company, stage, note }.
export async function POST(request) {
  const body = await request.json().catch(() => ({}));
  const name = typeof body.name === "string" ? body.name.trim() : "";
  if (!name) {
    return NextResponse.json({ error: "name is required" }, { status: 400 });
  }
  const doc = {
    name,
    email: typeof body.email === "string" ? body.email.trim() : "",
    company: typeof body.company === "string" ? body.company.trim() : "",
    stage: STAGES.includes(body.stage) ? body.stage : "lead",
    note: typeof body.note === "string" ? body.note.trim() : "",
    createdAt: new Date(),
  };
  const col = await contacts();
  const res = await col.insertOne(doc);
  return NextResponse.json({ id: res.insertedId.toString(), ...doc }, { status: 201 });
}

// PATCH /api/contacts — update a contact's stage (or other fields). Body: { id, stage }.
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

// DELETE /api/contacts?id=<id> — remove a contact.
export async function DELETE(request) {
  const id = new URL(request.url).searchParams.get("id");
  if (!id || !ObjectId.isValid(id)) {
    return NextResponse.json({ error: "valid id is required" }, { status: 400 });
  }
  const col = await contacts();
  await col.deleteOne({ _id: new ObjectId(id) });
  return NextResponse.json({ ok: true });
}
