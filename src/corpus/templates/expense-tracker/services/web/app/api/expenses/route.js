// App Router route handler for the `expenses` collection.
// GET  -> list expenses, POST -> add an expense, DELETE -> remove one by id.
//
// To adapt this app, rename the collection and change the fields to match your
// own data.
import { NextResponse } from "next/server";
import { ObjectId } from "mongodb";
import { getDb } from "../../../lib/db.js";

// Never cache — always read/write live data.
export const dynamic = "force-dynamic";

function shape(e) {
  return {
    id: e._id.toString(),
    description: e.description,
    amount: e.amount,
    category: e.category,
    date: e.date,
  };
}

async function expenses() {
  const db = await getDb();
  return db.collection("expenses");
}

// GET /api/expenses — list all expenses, newest first.
export async function GET() {
  const col = await expenses();
  const items = await col.find({}).sort({ date: -1, createdAt: -1 }).toArray();
  return NextResponse.json(items.map(shape));
}

// POST /api/expenses — add an expense.
// Body: { description: string, amount: number, category: string, date: string }.
export async function POST(request) {
  const body = await request.json().catch(() => ({}));
  const description = typeof body.description === "string" ? body.description.trim() : "";
  const amount = typeof body.amount === "number" ? body.amount : Number.parseFloat(body.amount);
  const category = typeof body.category === "string" && body.category.trim() ? body.category.trim() : "Other";
  const date = typeof body.date === "string" && body.date ? body.date : new Date().toISOString().slice(0, 10);
  if (!description || !Number.isFinite(amount)) {
    return NextResponse.json({ error: "description and a numeric amount are required" }, { status: 400 });
  }
  const col = await expenses();
  const doc = { description, amount, category, date, createdAt: new Date() };
  const res = await col.insertOne(doc);
  return NextResponse.json(shape({ ...doc, _id: res.insertedId }), { status: 201 });
}

// DELETE /api/expenses?id=<id> — remove an expense.
export async function DELETE(request) {
  const id = new URL(request.url).searchParams.get("id");
  if (!id || !ObjectId.isValid(id)) {
    return NextResponse.json({ error: "valid id is required" }, { status: 400 });
  }
  const col = await expenses();
  await col.deleteOne({ _id: new ObjectId(id) });
  return NextResponse.json({ ok: true });
}
