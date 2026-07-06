// App Router route handler for the `invoices` collection.
// GET -> list invoices, POST -> add an invoice, PATCH -> change status
// (e.g. mark paid), DELETE -> remove an invoice by id.
//
// To adapt this app, rename the collection and change the fields to match your
// own data (e.g. an `estimates` or `bills` collection).
import { NextResponse } from "next/server";
import { ObjectId } from "mongodb";
import { getDb } from "../../../lib/db.js";

// Never cache — always read/write live data.
export const dynamic = "force-dynamic";

const STATUSES = ["draft", "sent", "paid"];

async function invoices() {
  const db = await getDb();
  return db.collection("invoices");
}

function shape(i) {
  return {
    id: i._id.toString(),
    number: i.number || "",
    client: i.client || "",
    amount: typeof i.amount === "number" ? i.amount : 0,
    status: STATUSES.includes(i.status) ? i.status : "draft",
    due: i.due || "",
  };
}

// GET /api/invoices — list all invoices, newest first.
export async function GET() {
  const col = await invoices();
  const items = await col.find({}).sort({ createdAt: -1 }).toArray();
  return NextResponse.json(items.map(shape));
}

// POST /api/invoices — add an invoice. Body: { number, client, amount, status, due }.
export async function POST(request) {
  const body = await request.json().catch(() => ({}));
  const number = typeof body.number === "string" ? body.number.trim() : "";
  const client = typeof body.client === "string" ? body.client.trim() : "";
  if (!number || !client) {
    return NextResponse.json({ error: "number and client are required" }, { status: 400 });
  }
  const amount = Number(body.amount);
  const doc = {
    number,
    client,
    amount: Number.isFinite(amount) ? amount : 0,
    status: STATUSES.includes(body.status) ? body.status : "draft",
    due: typeof body.due === "string" ? body.due.trim() : "",
    createdAt: new Date(),
  };
  const col = await invoices();
  const res = await col.insertOne(doc);
  return NextResponse.json({ id: res.insertedId.toString(), ...doc }, { status: 201 });
}

// PATCH /api/invoices — change an invoice's status (e.g. mark paid). Body: { id, status }.
export async function PATCH(request) {
  const body = await request.json().catch(() => ({}));
  const { id, status } = body;
  if (!id || !ObjectId.isValid(id) || !STATUSES.includes(status)) {
    return NextResponse.json({ error: "valid id and status required" }, { status: 400 });
  }
  const col = await invoices();
  await col.updateOne({ _id: new ObjectId(id) }, { $set: { status } });
  return NextResponse.json({ ok: true });
}

// DELETE /api/invoices?id=<id> — remove an invoice.
export async function DELETE(request) {
  const id = new URL(request.url).searchParams.get("id");
  if (!id || !ObjectId.isValid(id)) {
    return NextResponse.json({ error: "valid id is required" }, { status: 400 });
  }
  const col = await invoices();
  await col.deleteOne({ _id: new ObjectId(id) });
  return NextResponse.json({ ok: true });
}
