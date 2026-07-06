// App Router route handler for the `items` collection.
// GET -> list items, POST -> add an item, PATCH -> adjust quantity (delta),
// DELETE -> remove an item by id.
//
// To adapt this app, rename the collection and change the fields to match your
// own data (e.g. a `parts` or `assets` collection).
import { NextResponse } from "next/server";
import { ObjectId } from "mongodb";
import { getDb } from "../../../lib/db.js";

// Never cache — always read/write live data.
export const dynamic = "force-dynamic";

async function items() {
  const db = await getDb();
  return db.collection("items");
}

function shape(it) {
  const qty = typeof it.qty === "number" ? it.qty : 0;
  const reorderAt = typeof it.reorderAt === "number" ? it.reorderAt : 0;
  return {
    id: it._id.toString(),
    sku: it.sku || "",
    name: it.name || "",
    qty,
    location: it.location || "",
    reorderAt,
    low: qty <= reorderAt,
  };
}

// GET /api/items — list all items, newest first.
export async function GET() {
  const col = await items();
  const list = await col.find({}).sort({ createdAt: -1 }).toArray();
  return NextResponse.json(list.map(shape));
}

// POST /api/items — add an item. Body: { sku, name, qty, location, reorderAt }.
export async function POST(request) {
  const body = await request.json().catch(() => ({}));
  const sku = typeof body.sku === "string" ? body.sku.trim() : "";
  const name = typeof body.name === "string" ? body.name.trim() : "";
  if (!sku || !name) {
    return NextResponse.json({ error: "sku and name are required" }, { status: 400 });
  }
  const qty = Number(body.qty);
  const reorderAt = Number(body.reorderAt);
  const doc = {
    sku,
    name,
    qty: Number.isFinite(qty) ? Math.trunc(qty) : 0,
    location: typeof body.location === "string" ? body.location.trim() : "",
    reorderAt: Number.isFinite(reorderAt) ? Math.trunc(reorderAt) : 0,
    createdAt: new Date(),
  };
  const col = await items();
  const res = await col.insertOne(doc);
  return NextResponse.json(shape({ _id: res.insertedId, ...doc }), { status: 201 });
}

// PATCH /api/items — adjust quantity by a delta (never below 0). Body: { id, delta }.
export async function PATCH(request) {
  const body = await request.json().catch(() => ({}));
  const { id } = body;
  const delta = Number(body.delta);
  if (!id || !ObjectId.isValid(id) || !Number.isFinite(delta)) {
    return NextResponse.json({ error: "valid id and numeric delta required" }, { status: 400 });
  }
  const col = await items();
  const doc = await col.findOne({ _id: new ObjectId(id) });
  if (!doc) return NextResponse.json({ error: "not found" }, { status: 404 });
  const qty = Math.max(0, (typeof doc.qty === "number" ? doc.qty : 0) + Math.trunc(delta));
  await col.updateOne({ _id: doc._id }, { $set: { qty } });
  return NextResponse.json(shape({ ...doc, qty }));
}

// DELETE /api/items?id=<id> — remove an item.
export async function DELETE(request) {
  const id = new URL(request.url).searchParams.get("id");
  if (!id || !ObjectId.isValid(id)) {
    return NextResponse.json({ error: "valid id is required" }, { status: 400 });
  }
  const col = await items();
  await col.deleteOne({ _id: new ObjectId(id) });
  return NextResponse.json({ ok: true });
}
