// App Router route handler for the `cards` collection.
// GET -> list cards, POST -> add a card, PATCH -> move a card (change column),
// DELETE -> remove a card by id.
//
// To adapt this app, rename the collection, change the columns, or add fields.
import { NextResponse } from "next/server";
import { ObjectId } from "mongodb";
import { getDb } from "../../../lib/db.js";

// Never cache — always read/write live data.
export const dynamic = "force-dynamic";

const COLUMNS = ["todo", "doing", "done"];

async function cards() {
  const db = await getDb();
  return db.collection("cards");
}

function shape(c) {
  return {
    id: c._id.toString(),
    title: c.title || "",
    column: COLUMNS.includes(c.column) ? c.column : "todo",
    order: typeof c.order === "number" ? c.order : 0,
  };
}

// GET /api/cards — list all cards, ordered within a column.
export async function GET() {
  const col = await cards();
  const items = await col.find({}).sort({ order: 1, createdAt: 1 }).toArray();
  return NextResponse.json(items.map(shape));
}

// POST /api/cards — add a card. Body: { title }.
export async function POST(request) {
  const body = await request.json().catch(() => ({}));
  const title = typeof body.title === "string" ? body.title.trim() : "";
  if (!title) {
    return NextResponse.json({ error: "title is required" }, { status: 400 });
  }
  const doc = { title, column: "todo", order: Date.now(), createdAt: new Date() };
  const col = await cards();
  const res = await col.insertOne(doc);
  return NextResponse.json({ id: res.insertedId.toString(), ...doc }, { status: 201 });
}

// PATCH /api/cards — move a card to another column. Body: { id, column }.
export async function PATCH(request) {
  const body = await request.json().catch(() => ({}));
  const { id, column } = body;
  if (!id || !ObjectId.isValid(id) || !COLUMNS.includes(column)) {
    return NextResponse.json({ error: "valid id and column required" }, { status: 400 });
  }
  const col = await cards();
  await col.updateOne({ _id: new ObjectId(id) }, { $set: { column } });
  return NextResponse.json({ ok: true });
}

// DELETE /api/cards?id=<id> — remove a card.
export async function DELETE(request) {
  const id = new URL(request.url).searchParams.get("id");
  if (!id || !ObjectId.isValid(id)) {
    return NextResponse.json({ error: "valid id is required" }, { status: 400 });
  }
  const col = await cards();
  await col.deleteOne({ _id: new ObjectId(id) });
  return NextResponse.json({ ok: true });
}
