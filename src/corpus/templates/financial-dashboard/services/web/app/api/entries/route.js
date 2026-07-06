// App Router route handler for the `entries` collection.
// GET  -> list entries, POST -> add an entry, DELETE -> remove an entry by id.
//
// Domain: an entry is { account: string, amount: number, type: "income"|"expense", at: Date }.
// To adapt this app, rename the collection and change the fields to match your
// own data.
import { NextResponse } from "next/server";
import { ObjectId } from "mongodb";
import { getDb } from "../../../lib/db.js";

// Never cache — always read/write live data.
export const dynamic = "force-dynamic";

async function entries() {
  const db = await getDb();
  return db.collection("entries");
}

function serialize(e) {
  return {
    id: e._id.toString(),
    account: e.account,
    amount: e.amount,
    type: e.type,
    at: e.at instanceof Date ? e.at.toISOString() : e.at,
  };
}

// GET /api/entries — list all entries, newest first.
export async function GET() {
  const col = await entries();
  const items = await col.find({}).sort({ at: -1 }).toArray();
  return NextResponse.json(items.map(serialize));
}

// POST /api/entries — add an entry. Body: { account, amount, type }.
export async function POST(request) {
  const body = await request.json().catch(() => ({}));
  const account = typeof body.account === "string" ? body.account.trim() : "";
  const amount = Number(body.amount);
  const type = body.type === "expense" ? "expense" : "income";
  if (!account) {
    return NextResponse.json({ error: "account is required" }, { status: 400 });
  }
  if (!Number.isFinite(amount) || amount <= 0) {
    return NextResponse.json({ error: "amount must be a positive number" }, { status: 400 });
  }
  const col = await entries();
  const doc = { account, amount, type, at: new Date() };
  const res = await col.insertOne(doc);
  return NextResponse.json(serialize({ _id: res.insertedId, ...doc }), { status: 201 });
}

// DELETE /api/entries?id=<id> — remove an entry.
export async function DELETE(request) {
  const id = new URL(request.url).searchParams.get("id");
  if (!id || !ObjectId.isValid(id)) {
    return NextResponse.json({ error: "valid id is required" }, { status: 400 });
  }
  const col = await entries();
  await col.deleteOne({ _id: new ObjectId(id) });
  return NextResponse.json({ ok: true });
}
